import { getOctokit } from '@actions/github';

type Platform = {
  signature: string;
  url: string;
};

type VersionContent = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: {
    [key: string]: Platform;
  };
};

if (process.env.GITHUB_TOKEN === undefined) {
  throw new Error('GITHUB_TOKEN is required');
}
const tagName = process.env.VERSION;
if (!tagName) {
  throw new Error('VERSION is not defined');
}
const version = tagName.replace('v', '');
const github = getOctokit(process.env.GITHUB_TOKEN);
const repoName = process.env.GITHUB_REPOSITORY ?? '';
const [owner, repo] = repoName.split('/');

if (!repoName) {
  throw new Error('GITHUB_REPOSITORY is not defined');
}

const allReleases = await github.rest.repos.listReleases({
  owner,
  repo,
  per_page: 100,
});
const matchingRelease = allReleases.data.find(r => r.tag_name === process.env.VERSION);
if (!matchingRelease) {
  throw new Error(`Release with tag ${process.env.VERSION} not found`);
}
const release = await github.rest.repos.getRelease({
  owner,
  repo,
  release_id: matchingRelease.id,
});

const releaseId = release.data.id;
const notes = release.data.body || '';

function createFileContent() {
  return {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {},
  } as VersionContent;
}

const files: { [str: string]: VersionContent } = {
  operations_stable: createFileContent(),
  operations_experimental: createFileContent(),
  investment_stable: createFileContent(),
  investment_experimental: createFileContent(),
};

const existingAssets = await github.rest.repos.listReleaseAssets({
  owner,
  repo,
  release_id: releaseId,
  per_page: 100,
});

for (const data of existingAssets.data) {
  const { name, browser_download_url } = data;
  if (!name) continue;
  if (!name.endsWith('.sig')) continue;
  const sigdata = await github.request(
    'GET /repos/{owner}/{repo}/releases/assets/{asset_id}',
    {
      owner,
      repo,
      asset_id: data.id,
      headers: {
        Accept: 'application/octet-stream',
      },
    }
  );
  const signature = Buffer.from(sigdata.data as unknown as Uint8Array).toString('utf-8');
  const isExperimental = name.includes('Experimental');
  const isDebug = name.includes('-debug');
  const appType = (name.match(/Argon\.(Operations|Investment)/)?.[1] || '').toLowerCase();
  const fileKey = `${appType}_${isExperimental ? 'experimental' : 'stable'}`;
  const file = files[fileKey];
  const downloadUrl = browser_download_url.replace(
    /\/download\/(untagged-[^/]+)\//,
    `/download/${encodeURIComponent(tagName)}/`,
  ).replace('.sig', '');

  if (!file) {
    console.warn(`No version found for ${fileKey}`);
    continue;
  }

  if (name.includes('x64-setup')) {
    for (let key of ['windows-x86_64', 'windows-x86_64-nsis']) {
      if (isDebug) {
        key += '-debug';
      }
      file.platforms[key] = {
        signature,
        url: downloadUrl,
      };
    }
  } else if (name.match(/universal(-debug)?.app.tar.gz/)) {
    for (let key of [
      'darwin-universal',
      'darwin-universal-app',
      'darwin-aarch64',
      'darwin-x86_64',
      'darwin-aarch64-app',
      'darwin-x86_64-app',
    ]) {
      if (isDebug) {
        key += '-debug';
      }
      file.platforms[key] = {
        signature,
        url: downloadUrl,
      };
    }
  } else if (name.includes('.AppImage')) {
    for (let key of ['linux-x86_64', 'linux-x86_64-appimage']) {
      if (isDebug) {
        key += '-debug';
      }
      file.platforms[key] = {
        signature,
        url: downloadUrl,
      };
    }
  } else if (name.match(/amd64(-debug)?\.deb/g)) {
    let key = 'linux-x86_64-deb';
    if (isDebug) {
      key += '-debug';
    }
    file.platforms[key] = {
      signature,
      url: downloadUrl,
    };
  } else {
    console.warn('Unknown asset name format:', name);
  }
}


for (const [fileKey, file] of Object.entries(files)) {
  const fileName = `${fileKey.replace('_', '-')}.json`;
  const rawRecord = JSON.stringify(file, null, 2);
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.from(rawRecord).byteLength,
  };

  const existingAsset = existingAssets.data.find(a => a.label === fileName);

  if (process.env.READONLY) {
    console.log(`READONLY mode: Skipping upload of ${fileName}`, {
      existingAsset: existingAsset ? 'exists' : 'not found',
      headers,
      rawRecord
    });
    continue;
  }
  if (existingAsset) {
    console.log(`Deleting existing ${fileName}...`);
    await github.rest.repos.deleteReleaseAsset({
      owner,
      repo,
      asset_id: existingAsset.id,
    });
  }

  console.log(`Uploading ${fileName}...`);

  await retry(
    () =>
      github.rest.repos.uploadReleaseAsset({
        headers,
        name: fileName,
        // GitHub renames the filename so we'll also set the label which it leaves as-is.
        label: fileName,
        data: rawRecord,
        owner,
        repo,
        release_id: releaseId,
      }),
    1,
  );

  console.log(`${fileName} successfully uploaded.`);
}

async function retry(fn: () => Promise<unknown>, additionalAttempts: number): Promise<unknown> {
  const attempts = additionalAttempts + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.log(`Attempt ${attempt} failed. ${attempts - attempt} tries left.`);
    }
  }
}
