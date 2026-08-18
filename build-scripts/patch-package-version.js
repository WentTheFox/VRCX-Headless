const fs = require('fs');
const path = require('path');
const { getForkVersion } = require('./utils');

const rootDir = path.join(__dirname, '..');
const packageJsonPath = path.resolve(rootDir, 'package.json');

// Uses the fork's own version (20260718.5.0-style, same scheme as the
// Docker image tag) rather than the plain VRCX date -- this is what
// electron-builder's implicit NSIS target stamps into the Windows
// installer's filename/Product Version metadata (Windows has no explicit
// `win` artifactName in electron-builder.config.js, unlike Linux/macOS
// which get an explicit rename via build-scripts/rename-builds.js). Fixed
// live (2026-08-18) after the first real release shipped with plain VRCX
// dates in every filename, giving no visual distinction from a vanilla
// VRCX download and no way to tell which fork build a user has installed.
let version = '';
try {
    version = getForkVersion();
} catch (err) {
    console.error('Error computing fork version:', err);
    process.exit(1);
}

let packageJson = {};
try {
    console.log(`Reading package.json from ${packageJsonPath}`);
    const packageData = fs.readFileSync(packageJsonPath, 'utf8');
    packageJson = JSON.parse(packageData);
} catch (err) {
    console.error('Error reading package.json:', err);
    process.exit(1);
}

packageJson.version = version;

try {
    fs.writeFileSync(
        packageJsonPath,
        JSON.stringify(packageJson, null, 4),
        'utf8'
    );
    console.log(`Updated version in package.json to: ${version}`);
} catch (err) {
    console.error('Error writing to package.json:', err);
    process.exit(1);
}
