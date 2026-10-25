PRAGMA foreign_keys = ON;
CREATE TABLE publishers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
  keys_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  verified_at INTEGER NOT NULL
);
CREATE TABLE invitations (
  hash TEXT PRIMARY KEY, publisher_id TEXT NOT NULL, name TEXT NOT NULL,
  email TEXT NOT NULL, verification_reason TEXT NOT NULL, recovery INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE tokens (
  hash TEXT PRIMARY KEY, publisher_id TEXT NOT NULL REFERENCES publishers(id),
  expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX tokens_publisher ON tokens(publisher_id);
CREATE TABLE artifacts (
  publisher_id TEXT NOT NULL REFERENCES publishers(id), hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('package', 'image')), size INTEGER NOT NULL,
  mime TEXT NOT NULL, manifest_json TEXT, signature TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY(publisher_id, hash)
);
CREATE TABLE submissions (
  id TEXT PRIMARY KEY, publisher_id TEXT NOT NULL REFERENCES publishers(id),
  app_id TEXT NOT NULL, version TEXT NOT NULL, package_hash TEXT NOT NULL,
  icon_hash TEXT NOT NULL, screenshots_json TEXT NOT NULL, changelog TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at INTEGER NOT NULL
);
CREATE INDEX submissions_publisher ON submissions(publisher_id, created_at);
CREATE TABLE reviews (
  submission_id TEXT PRIMARY KEY REFERENCES submissions(id), decision TEXT NOT NULL,
  note TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE versions (
  app_id TEXT NOT NULL, version TEXT NOT NULL,
  submission_id TEXT UNIQUE NOT NULL REFERENCES submissions(id), published_at INTEGER NOT NULL,
  PRIMARY KEY(app_id, version)
);
CREATE TABLE revocations (
  app_id TEXT NOT NULL, version TEXT NOT NULL, reason TEXT NOT NULL,
  PRIMARY KEY(app_id, version)
);
CREATE TABLE reports (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL, version TEXT, reason TEXT NOT NULL,
  created_at INTEGER NOT NULL, resolution TEXT, resolved_at INTEGER
);
CREATE TABLE rate_limits (id TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE audit (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
  subject TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE operation_guards (id INTEGER PRIMARY KEY CHECK(id = 1), ok INTEGER NOT NULL CHECK(ok = 1));
CREATE TABLE registry_state (
  id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, published_revision INTEGER NOT NULL DEFAULT -1,
  object_key TEXT, expires_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO registry_state(id, revision, updated_at) VALUES (1, 0, 0);
