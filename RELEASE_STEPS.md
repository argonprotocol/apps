## Steps to create a new release
1. Update the version number (this will update the data files and update version files everywhere)
   ```bash
   yarn version <new-version>
   ```
2. Update the release notes in `RELEASE_NOTES.md` following the [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format.
3. Create a version branch
   ```bash
   git checkout -b v<new-version>
   ```
4. Commit the changes
5. Push the branch to the remote repository
   ```bash
   git push origin v<new-version>
   ```
6. This will trigger the CI/CD pipeline to create a new release.
7. Once you are happy with the release, publish it via github. This will create a tag and update it as the latest stable or experimental release.
8. Merge the version branch back into `main`
