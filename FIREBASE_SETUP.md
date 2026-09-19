# Firebase setup for LangLens

Project: `halogen-bonus-4phrv`. The app continues to run as a static GitHub Pages site.

## Services

1. Add Firebase to the Google Cloud project, register a **Web app**, and copy its public web configuration into `js/firebase-config.js` as `window.LANGLENS_FIREBASE_CONFIG = { ... };`. These are public client settings, not administrative credentials. Never add a service-account key to the repository.
2. Enable Authentication → Google. Add `jiazhengchai.github.io`, `localhost`, and `127.0.0.1` under Authentication → Settings → Authorized domains.
3. The default **Firestore Standard edition** database is provisioned in `us-central1` (Iowa), with the checked-in rules and index exclusions deployed. For a new project, explicitly select the desired location before the first deployment; Firebase CLI otherwise defaults to `nam5`. Database locations cannot be changed in place.
4. Cloud Storage is provisioned on the existing Blaze billing account: `halogen-bonus-4phrv.firebasestorage.app`, in `US-CENTRAL1`. Private owner-only rules and browser download CORS are deployed.

```powershell
npx firebase-tools login
npx firebase-tools deploy --only firestore --project halogen-bonus-4phrv
# After provisioning the bucket:
npx firebase-tools deploy --only storage --project halogen-bonus-4phrv
gcloud storage buckets update gs://YOUR_BUCKET --cors-file=storage.cors.json
```

Use `storage.cors.json` for authenticated browser downloads. Adjust its origin list if hosting changes. Storage access stays restricted to each Firebase user's UID; do not make the bucket public.

## User flow

- Signed-out users keep the original local library. Signing in opens a separate local database for that account and automatically loads cloud progress.
- On first sign-in to a never-used, empty cloud account, the existing guest library migrates automatically. The original guest copy is retained; a migration marker prevents automatic reuse in a different account. Existing cloud accounts can use **Bring local progress into this account** to merge a guest library explicitly. Cloud deletions never trigger automatic recovery. Existing JSON files can also be restored using the existing Restore dialog.
- Edits persist locally first. Changes sync shortly afterward, on reconnect, and when the app becomes visible. Other devices receive notifications through a small Firestore revision document.
- Simultaneous edits to different records merge. Competing edits to the same record pause synchronization and offer both versions for review; there is no silent last-device-wins overwrite.
- Signing out switches back to the guest library. Pending changes stay in the account's local cache and sync after signing back in.
- **Clear Data while signed in also deletes the cloud library after syncing.** JSON backups remain available for recovery. Cloud sync itself is not a historical backup.

## Costs and limits

Firestore Standard has a project-wide free allowance of 1 GiB stored, 50,000 document reads/day, 20,000 writes/day, 20,000 deletes/day, and 10 GiB outbound/month. Google sign-in is free at small scale. Confirm current rates at https://firebase.google.com/pricing.

Cloud Storage requires billing enabled. Storage region, stored bytes, operations, and downloads determine charges. Set billing alerts, but remember alerts do not cap spending.

This first implementation reads the record collections when another device changes the cloud revision. It only writes changed records and skips rereading unchanged cloud revisions. Larger libraries or many simultaneous devices will use more reads than an incremental change-feed design.

Files use content-addressed Storage objects (50 MiB maximum each); text/notes have a 750 KB serialized-record limit. Large records are retained locally and explicitly reported as unsynced. Unreferenced file objects are retained to avoid breaking another device or a conflict; account/file garbage collection is a future maintenance task. Cloud records are protected by account rules, but are not passphrase-encrypted like the optional JSON backups.

## Verification

Run `npm test` for existing backup tests plus offline merges, delete/edit conflicts, account isolation, migration ID remapping, and edits during upload. After configuring the project, test Google sign-in in two browser profiles, an offline edit and reconnect, simultaneous changes, a file upload/download, and cross-user access denial before publishing.

Verified during setup: Google sign-in and session persistence; a real temporary item saved to Firestore and removed through the app; 38 local tests; 18 server-side Firestore/Storage rule evaluations. Tests include one-time guest migration and file upload failure/retry/restore through two independent clients.

The original project, `langlens-509100`, could not attach billing because of a project quota. The backend moved to the already-billed `halogen-bonus-4phrv` project, preserving the Google account UID, existing cloud records and revision. Old cloud data is retained with client access disabled so stale tabs cannot sync against the retired backend. Live attachment verification is pending the production sign-in.
