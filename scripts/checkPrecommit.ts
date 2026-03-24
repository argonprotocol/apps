import * as PackageJson from '../package.json';

for (const [key, value] of Object.entries(PackageJson.resolutions ?? {})) {
  if (value.includes('portal:.')) {
    console.error(
      `Error: The package ${key} has a resolution that includes 'portal:.' (a file path), which is not allowed.`,
    );
    process.exit(1);
  }
}
process.exit(0);
