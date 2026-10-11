#!/usr/bin/env python3
"""Verified EveryOS bootstrap. The trusted publisher key is supplied out of band."""
import argparse
import base64
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import subprocess
import tempfile
import time
from urllib.parse import urljoin, urlparse, unquote

REDIRECTS = {"release-assets.githubusercontent.com", "objects.githubusercontent.com"}
DEFAULT_RELEASE_SOURCE = "https://github.com/goktugcy/everyos/releases"
VERSION = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\Z")
LIMIT = 512 * 1024 * 1024

def enable_network_access(config):
    trusted(config)
    info = config.stat()
    content = config.read_bytes()
    original = b"server:\n  host: 127.0.0.1\n  port: 7470\n"
    if not content.startswith(original):
        raise ValueError("Unexpected fresh installation network configuration")
    content = content.replace(original, b"server:\n  host: 0.0.0.0\n  port: 7470\n", 1)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=config.parent, prefix=".network-config-", delete=False) as handle:
            temporary = Path(handle.name)
            os.fchown(handle.fileno(), info.st_uid, info.st_gid)
            os.fchmod(handle.fileno(), stat.S_IMODE(info.st_mode))
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, config)
        sync_directory(config.parent)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

def interface_addresses(interfaces):
    addresses = {}
    for interface in interfaces:
        name = interface.get("ifname", "")
        if "UP" not in interface.get("flags", []) or name == "lo" or name.startswith(("docker", "br-", "veth", "cni", "flannel", "virbr", "vnet", "podman")):
            continue
        for info in interface.get("addr_info", []):
            if info.get("family") != "inet" or info.get("scope") != "global":
                continue
            try:
                address = ipaddress.ip_address(info.get("local", ""))
            except ValueError:
                continue
            if address.version != 4 or address.is_loopback or address.is_link_local or address.is_multicast or address.is_unspecified:
                continue
            addresses.setdefault(address, name)
    return [str(address) for address in sorted(addresses, key=lambda address: (not addresses[address].startswith("tailscale"), int(address)))]

def print_access_urls():
    print("Open EveryOS:")
    print("  On this host: http://127.0.0.1:7470")
    try:
        interfaces = json.loads(subprocess.check_output(["ip", "-j", "-4", "address", "show", "up"], text=True, timeout=5))
        addresses = interface_addresses(interfaces)
    except (OSError, ValueError, subprocess.SubprocessError):
        print("  Network address detection is unavailable; inspect the host's IPv4 addresses.")
        return
    reachable = []
    for address in addresses:
        connection = http.client.HTTPConnection(address, 7470, timeout=2)
        try:
            connection.request("GET", "/api/health")
            response = connection.getresponse()
            if response.status == 200 and json.loads(response.read(4096)).get("status") == "ok":
                reachable.append(address)
        except (OSError, ValueError):
            pass
        finally:
            connection.close()
    for address in reachable:
        print(f"  From another device: http://{address}:7470")
    if not reachable:
        print("  No active IPv4 network address responds on port 7470. Existing configuration is preserved.")

def canonical_release_source(source):
    parsed = urlparse(source)
    if parsed.scheme == "https" and parsed.hostname == "github.com" and parsed.port in [None, 443] and not (parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.params) and parsed.path.rstrip("/").lower() == "/goktugcy/otuken/releases":
        return DEFAULT_RELEASE_SOURCE
    return source

def trusted(path, directory=False):
    info = path.lstat()
    if path.resolve() != path or info.st_uid != 0 or info.st_mode & 0o022 or (directory and not path.is_dir()) or (not directory and not path.is_file()):
        raise ValueError("Update paths must be root-owned without symlinks or other-account write access")
    if path != Path("/"):
        trusted(path.parent, True)

def download(url, limit, redirects=0, deadline=None):
    if deadline is None:
        deadline = time.monotonic() + 600
    if time.monotonic() >= deadline:
        raise ValueError("Release download deadline exceeded")
    parsed = urlparse(url)
    if parsed.username or parsed.password or parsed.fragment:
        raise ValueError("Invalid release URL")
    if parsed.scheme == "file":
        if parsed.netloc:
            raise ValueError("File source must be local")
        path = Path(unquote(parsed.path))
        trusted(path)
        if path.stat().st_size > limit:
            raise ValueError("Release file is too large")
        return path.read_bytes()
    if parsed.scheme != "https" or parsed.port not in [None, 443]:
        raise ValueError("Release downloads require HTTPS")
    addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global or getattr(ip, "ipv4_mapped", None) or getattr(ip, "sixtofour", None) or getattr(ip, "teredo", None):
            raise ValueError("Release source must use public addresses")
    class PinnedHTTPS(http.client.HTTPSConnection):
        def connect(self):
            sock = socket.create_connection((addresses[0][4][0], 443), timeout=30)
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
    connection = PinnedHTTPS(parsed.hostname, timeout=30, context=ssl.create_default_context())
    try:
        connection.request("GET", parsed.path + ("?" + parsed.query if parsed.query else ""), headers={"User-Agent": "EveryOS-installer"})
        response = connection.getresponse()
        if response.status in [301, 302, 303, 307, 308]:
            target = urljoin(url, response.getheader("location", ""))
            if redirects >= 4 or (urlparse(target).hostname != parsed.hostname and urlparse(target).hostname not in REDIRECTS):
                raise ValueError("Untrusted release redirect")
            return download(target, limit, redirects + 1, deadline)
        if response.status != 200:
            raise ValueError(f"Release server returned {response.status}")
        data = bytearray()
        while True:
            if time.monotonic() > deadline:
                raise ValueError("Release download deadline exceeded")
            chunk = response.read(min(65536, limit + 1 - len(data)))
            if not chunk:
                return bytes(data)
            data.extend(chunk)
            if len(data) > limit:
                raise ValueError("Release download is too large")
    finally:
        connection.close()

def verify(envelope, public_key):
    signed = json.loads(envelope)
    if set(signed) != {"payload", "signature"}:
        raise ValueError("Invalid release envelope")
    payload = base64.b64decode(signed["payload"], validate=True)
    signature = base64.b64decode(signed["signature"], validate=True)
    if len(signature) != 64:
        raise ValueError("Invalid release signature")
    with tempfile.TemporaryDirectory(prefix="everyos-signature-") as temp:
        directory = Path(temp)
        (directory / "payload").write_bytes(payload)
        (directory / "signature").write_bytes(signature)
        (directory / "key").write_bytes(public_key)
        result = subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(directory / "key"), "-rawin", "-in", str(directory / "payload"), "-sigfile", str(directory / "signature")], capture_output=True)
        if result.returncode:
            raise ValueError("Invalid release signature")
    manifest = json.loads(payload)
    if set(manifest) != {"format", "version", "minVersion", "schemaVersion", "publishedAt", "expiresAt", "notes", "artifacts"}:
        raise ValueError("Invalid release manifest")
    if manifest["format"] != "everyos-release" or not VERSION.fullmatch(manifest["version"]) or not VERSION.fullmatch(manifest["minVersion"]):
        raise ValueError("Invalid release identity")
    now = time.time() * 1000
    if not isinstance(manifest["notes"], str) or len(manifest["notes"]) > 8000 or not isinstance(manifest["schemaVersion"], int) or manifest["schemaVersion"] <= 0 or not (manifest["publishedAt"] <= now + 300000 and manifest["expiresAt"] > now and manifest["expiresAt"] > manifest["publishedAt"]):
        raise ValueError("Release expired or invalid")
    if set(manifest["artifacts"]) != {"arm64", "amd64"}:
        raise ValueError("Invalid release architectures")
    for arch, artifact in manifest["artifacts"].items():
        if set(artifact) != {"file", "size", "sha256"} or artifact["file"] != f"everyos_{manifest['version']}_{arch}.deb" or not re.fullmatch(r"[a-f0-9]{64}", artifact["sha256"]) or type(artifact["size"]) != int or not 0 < artifact["size"] <= LIMIT:
            raise ValueError("Invalid package manifest")
    return manifest

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--public-key", type=Path, required=True)
    parser.add_argument("--source", default=DEFAULT_RELEASE_SOURCE)
    args = parser.parse_args()
    args.source = canonical_release_source(args.source)
    if os.geteuid() != 0 or not Path("/run/systemd/system").is_dir():
        parser.error("Run on a Linux systemd host as root")
    if Path("/var/lib/everyos/everyos.db").exists():
        parser.error("Existing EveryOS data: use the authenticated web/CLI update workflow")
    args.public_key = args.public_key.absolute()
    trusted(args.public_key)
    key = args.public_key.read_bytes()
    # The explicit trust anchor must be Ed25519, not another OpenSSL key type.
    key_type = subprocess.check_output(["openssl", "pkey", "-pubin", "-in", str(args.public_key), "-text", "-noout"], text=True)
    if "ED25519" not in key_type.upper():
        raise ValueError("Publisher key must be Ed25519")
    source = args.source.rstrip("/") + "/"
    parsed = urlparse(source)
    if parsed.query or parsed.fragment or parsed.username or parsed.password or parsed.scheme not in ["https", "file"]:
        raise ValueError("Invalid release source")
    envelope = download(urljoin(source, "latest/download/release.json"), 128 * 1024)
    manifest = verify(envelope, key)
    arch = subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip()
    if arch not in manifest["artifacts"]:
        raise ValueError("Unsupported architecture")
    artifact = manifest["artifacts"][arch]
    data = download(urljoin(source, f"download/v{manifest['version']}/{artifact['file']}"), artifact["size"])
    if len(data) != artifact["size"] or hashlib.sha256(data).hexdigest() != artifact["sha256"]:
        raise ValueError("Package checksum mismatch")
    with tempfile.TemporaryDirectory(prefix="everyos-install-") as temp:
        candidate = Path(temp) / artifact["file"]
        candidate.write_bytes(data)
        identity = subprocess.check_output(["dpkg-deb", "--field", str(candidate), "Package", "Version", "Architecture"], text=True).strip()
        if identity != f"Package: everyos\nVersion: {manifest['version']}\nArchitecture: {arch}":
            raise ValueError("Package identity mismatch")
        root = Path("/var/lib/everyos-updates")
        root.mkdir(mode=0o700, exist_ok=True)
        trusted(root, True)
        cache = root / "packages" / manifest["version"]
        cache.mkdir(parents=True, mode=0o700, exist_ok=True)
        trusted(cache, True)
        for name, content in [(artifact["file"], data), ("release.json", envelope)]:
            target = cache / name
            if target.exists():
                trusted(target)
                if target.read_bytes() != content:
                    raise ValueError("Cached release differs; inspect the failed installation before retrying")
            else:
                with target.open("xb") as handle:
                    handle.write(content)
                    handle.flush()
                    os.fsync(handle.fileno())
                target.chmod(0o600)
        sync_directory(cache)
        config_dir = Path("/etc/everyos")
        config_dir.mkdir(mode=0o750, exist_ok=True)
        trusted(config_dir, True)
        api_config = config_dir / "config.yaml"
        new_api_config = not (api_config.exists() or api_config.is_symlink())
        config = config_dir / "release.json"
        settings = {"source": args.source.rstrip("/"), "publicKey": key.decode(), "redirectHosts": sorted(REDIRECTS)}
        if config.exists():
            trusted(config)
            existing = json.loads(config.read_text())
            existing["source"] = canonical_release_source(existing["source"])
            if existing != settings:
                raise ValueError("Release trust configuration already exists and differs")
        else:
            with config.open("x") as handle:
                json.dump(settings, handle)
                handle.flush()
                os.fsync(handle.fileno())
            config.chmod(0o600)
            sync_directory(config_dir)
        subprocess.run(["apt-get", "install", "--yes", "--no-remove", "--no-install-recommends", "--", str(candidate)], check=True, env={**os.environ, "DEBIAN_FRONTEND": "noninteractive", "NEEDRESTART_MODE": "l"})
        # Only the initial installer opts into network access; package upgrades keep their binding.
        if new_api_config:
            enable_network_access(api_config)
            subprocess.run(["systemctl", "restart", "everyos-api.service"], check=True)
    for attempt in range(90):
        try:
            connection = http.client.HTTPConnection("127.0.0.1", 7470, timeout=2)
            connection.request("GET", "/api/health")
            response = connection.getresponse()
            ready = response.status == 200 and json.loads(response.read(4096)).get("status") == "ok"
            connection.close()
            if ready:
                break
        except (OSError, ValueError):
            pass
        time.sleep(1)
    else:
        raise ValueError("Services did not become ready; inspect journalctl -u everyos-api -u everyos-agent")
    print(f"Installed verified EveryOS {manifest['version']}. Setup token: /var/lib/everyos/setup-token")
    print_access_urls()

def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(f"EveryOS installation failed: {error}") from None
