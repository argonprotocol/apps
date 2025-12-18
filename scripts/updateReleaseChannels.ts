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

const versions = {
  stable: {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {},
  } as VersionContent,
  experimental: {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {},
  },
};

const existingAssets = await github.rest.repos.listReleaseAssets({
  owner,
  repo,
  release_id: releaseId,
  per_page: 100,
});

for (const data of existingAssets.data) {
  const {  name, browser_download_url } = data;
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
  let version: VersionContent;
  if (isExperimental) {
    version = versions.experimental;
  } else {
    version = versions.stable;
  }
  const updaterFileDownloadUrl = browser_download_url.replace(
    /\/download\/(untagged-[^/]+)\//,
    `/download/${encodeURIComponent(tagName)}/`,
  ).replace('.sig', '');

  if (name.includes('x64-setup')) {
    for (let key of ['windows-x86_64', 'windows-x86_64-nsis']) {
      if (isDebug) {
        key += '-debug';
      }
      version.platforms[key] = {
        signature,
        url: updaterFileDownloadUrl,
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
      version.platforms[key] = {
        signature,
        url: updaterFileDownloadUrl,
      };
    }
  } else if (name.includes('.AppImage')) {
    for (let key of ['linux-x86_64', 'linux-x86_64-appimage']) {
      if (isDebug) {
        key += '-debug';
      }
      version.platforms[key] = {
        signature,
        url: updaterFileDownloadUrl,
      };
    }
  } else if (name.match(/amd64(-debug)?\.deb/g)) {
    let key = 'linux-x86_64-deb';
    if (isDebug) {
      key += '-debug';
    }
    version.platforms[key] = {
      signature,
      url: updaterFileDownloadUrl,
    };
  } else {
    console.warn('Unknown asset name format:', name);
  }
}


for (const [name, data] of Object.entries(versions)) {
  const assetName = `${name}.json`;
  const rawRecord = JSON.stringify(data, null, 2);
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.from(rawRecord).byteLength,
  };

  const existingAsset = existingAssets.data.find(a => a.label === assetName);

  if (process.env.READONLY) {
    console.log(`READONLY mode: Skipping upload of ${assetName}`, {
      existingAsset: existingAsset ? 'exists' : 'not found',
      headers,
      rawRecord
    });
    continue;
  }
  if (existingAsset) {
    console.log(`Deleting existing ${assetName}...`);
    await github.rest.repos.deleteReleaseAsset({
      owner,
      repo,
      asset_id: existingAsset.id,
    });
  }

  console.log(`Uploading ${assetName}...`);

  await retry(
    () =>
      github.rest.repos.uploadReleaseAsset({
        headers,
        name: assetName,
        // GitHub renames the filename so we'll also set the label which it leaves as-is.
        label: assetName,
        data: rawRecord,
        owner,
        repo,
        release_id: releaseId,
      }),
    1,
  );

  console.log(`${assetName} successfully uploaded.`);
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
