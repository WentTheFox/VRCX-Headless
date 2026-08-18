const fs = require('fs');
const path = require('path');

/**
 * The fork's own release version -- same scheme as the Docker image tag
 * (server/src/globals.js's buildServerVersion): <vrcx-date-no-dots>.
 * <fork-build>.0, e.g. 20260718.5.0. Duplicated here rather than imported
 * across the ESM/CJS boundary for two lines of string-joining -- these
 * build scripts are plain CommonJS with no module-resolution hooks.
 */
function getForkVersion() {
    const rootDir = path.join(__dirname, '..');
    const vrcxVersion = fs
        .readFileSync(path.join(rootDir, 'Version'), 'utf8')
        .trim();
    const forkVersion = fs
        .readFileSync(path.join(rootDir, 'server', 'VERSION'), 'utf8')
        .trim();
    return `${vrcxVersion.replaceAll('.', '')}.${forkVersion}.0`;
}

function getArchAndPlatform() {
    // --arch= win32, darwin, linux
    // --platform= x64, arm64
    const args = process.argv.slice(2);
    let arch = process.arch.toString();
    let platform = process.platform.toString();
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--arch=')) {
            arch = args[i].split('=')[1];
        }
        if (args[i].startsWith('--platform=')) {
            platform = args[i].split('=')[1];
        }
    }
    console.log(`Using arch: ${arch}, platform: ${platform}`);
    return { arch, platform };
}

module.exports = { getArchAndPlatform, getForkVersion };
