const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'apps-script', 'src');

const findings = [];

for (const fileName of fs.readdirSync(srcDir).filter((name) => name.endsWith('.gs')).sort()) {
  const filePath = path.join(srcDir, fileName);
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const looksLikeIifeAssignment = /=\s*\(function\s*\(\)\s*\{/.test(trimmed);
    const isInvoked = /\}\)\s*\(/.test(trimmed) || /\}\)\s*\./.test(trimmed);

    if (looksLikeIifeAssignment && !isInvoked) {
      findings.push(`${path.relative(root, filePath)}:${index + 1}: ${trimmed}`);
    }
  });
}

if (findings.length > 0) {
  console.error('Found function expressions that look like missing IIFE invocation:');
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exit(1);
}

console.log('Apps Script IIFE check passed.');
