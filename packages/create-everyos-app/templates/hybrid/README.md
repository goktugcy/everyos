# %%APP_NAME%%

An EveryOS desktop app (%%TEMPLATE%% template).

```bash
npm install
npm run dev        # developer page with a MOCK desktop: http://127.0.0.1:5180
npm test           # validate the package, then run the tests
npm run pack       # %%APP_ID%%-1.0.0.eosapp
```

## Run it on EveryOS

`npx everyos-app dev --registry --host 0.0.0.0` also serves a signed development registry. In
EveryOS, open **App Store → Catalog sources → Add source**, choose _Private_ and _on my local
network_, paste the URL, public key and fingerprint it prints, then install the app. After a
change: **Sync now**, then **Update**. Nothing is bypassed: the app runs in EveryOS's sandbox with
the permissions people approve.

## Publish

1. `npx everyos-app registry init` creates your registry (and keys in `keys/`; the `.key` files are
   private: never commit or share them).
2. `npm run publish:registry` packs, signs and adds this version to `registry/`.
3. Upload `registry/` to any web server. People add its `index.json` URL with the fingerprint.

Nothing is ever published to the official EveryOS registry from here.
