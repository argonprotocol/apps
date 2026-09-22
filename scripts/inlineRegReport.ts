import Fs from 'node:fs';
import Path from 'node:path';

type ReportItem = { encoded: string };
type Report = {
  failedItems: ReportItem[];
  newItems: ReportItem[];
  deletedItems: ReportItem[];
  passedItems: ReportItem[];
  hasPassed: boolean;
};

const reportDir = process.argv[2];
if (!reportDir) throw new Error('Usage: inlineRegReport.ts <report-directory>');

const reportPath = Path.join(reportDir, 'index.html');
let html = Fs.readFileSync(reportPath, 'utf8');
const reportMatch = html.match(/window\['__reg__'\] = (.*);<\/script>/);

if (!reportMatch) throw new Error('Could not find the reg-cli report data');

const report = JSON.parse(reportMatch[1]) as Report;
const images: Record<string, string> = {};
const inline = (directory: string, items: ReportItem[]) => {
  for (const { encoded } of items) {
    const imagePath = Path.join(reportDir, directory, encoded);
    images[`${directory}/${encoded}`] = `data:image/png;base64,${Fs.readFileSync(imagePath, 'base64')}`;
  }
};

inline('actual', [...report.failedItems, ...report.newItems]);
inline('expected', [...report.failedItems, ...report.deletedItems]);
inline('diff', report.failedItems);

report.hasPassed = false;
report.passedItems = [];
html = html.replace(
  reportMatch[0],
  `window['__reg__'] = ${JSON.stringify(report)};window['__regImages__'] = ${JSON.stringify(images)};</script>`,
);

const imageResolver = 'const i=(a,l)=>t[a].replace(/\\\/$/,"")+"/"+l.replace(/^\\//,"");';
if (!html.includes(imageResolver)) throw new Error('Could not find the reg-cli image resolver');

html = html.replace(imageResolver, 'const i=(a,l)=>window.__regImages__[`${a}/${l}`];');
Fs.writeFileSync(reportPath, html);
