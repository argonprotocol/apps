## Steps to create a new release

1. Update the release notes in `RELEASE_NOTES.md` following the [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format.
2. Update the version number.
   ```bash
   yarn version <new-version>
   ```
3. Update the generated data and synchronize the version across the Tauri configuration files. These commands are explicit because Yarn 4 does not run the `postversion` script after `yarn version`.
   ```bash
   yarn update-data
   yarn build:version
   ```
4. Optionally update the mainchain version.
   ```bash
   yarn mainchain:pin v1.x.x
   ```
5. Verify that `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/tauri.desktop.experimental.conf.json` all contain the new version.
6. Create a version branch.
   ```bash
   git checkout -b v<new-version>
   ```
7. Commit the changes, including the generated data and synchronized Tauri configuration files.
   ```bash
   git add -A
   git commit -m "v<new-version>"
   ```
8. Push the branch to the remote repository.
   ```bash
   git push origin v<new-version>
   ```
9. This will trigger the CI/CD pipeline to create a new release.
10. Once you are happy with the release, publish it via GitHub. This will create a tag and update it as the latest stable or experimental release.
11. Merge the version branch back into `main`.
