const fs = require('fs');
const path = require('path');
const { getArchAndPlatform, getForkVersion } = require('./utils');

const rootDir = path.join(__dirname, '..');
const buildDir = path.join(rootDir, 'build');

// Uses the fork's own version and a VRCX-Headless-prefixed filename --
// matches electron-builder.config.js's literal "VRCX-Headless_Version.
// ${ext}" artifactName placeholder text (both sides of this rename must
// agree on that literal source name). Fixed live (2026-08-18): plain
// "VRCX_<vrcx-date>_<arch>" gave no visual distinction from a vanilla VRCX
// download and no way to tell which fork build was installed.
let version = '';
try {
    version = getForkVersion();
} catch (err) {
    console.error('Error computing fork version:', err);
    process.exit(1);
}

/**
 * Renames the build files for the specified architecture and platform
 * @param {string} arch
 * @param {string} platform
 */
function renameBuild(arch, platform) {
    if (platform === 'linux') {
        const oldAppImage = path.join(
            buildDir,
            `VRCX-Headless_Version.AppImage`
        );
        const newAppImage = path.join(
            buildDir,
            `VRCX-Headless_${version}_${arch}.AppImage`
        );
        try {
            if (fs.existsSync(oldAppImage)) {
                fs.renameSync(oldAppImage, newAppImage);
                console.log(`Renamed: ${oldAppImage} -> ${newAppImage}`);
            } else {
                console.log(`File not found: ${oldAppImage}`);
            }
        } catch (err) {
            console.error('Error renaming files:', err);
            process.exit(1);
        }
    } else if (platform === 'darwin') {
        const oldDmg = path.join(buildDir, `VRCX-Headless_Version.dmg`);
        const newDmg = path.join(
            buildDir,
            `VRCX-Headless_${version}_${arch}.dmg`
        );
        try {
            if (fs.existsSync(oldDmg)) {
                fs.renameSync(oldDmg, newDmg);
                console.log(`Renamed: ${oldDmg} -> ${newDmg}`);
            } else {
                console.log(`File not found: ${oldDmg}`);
            }
        } catch (err) {
            console.error('Error renaming files:', err);
            process.exit(1);
        }
    } else {
        console.log('No renaming needed for this platform.');
    }
}

const { arch, platform } = getArchAndPlatform();
renameBuild(arch, platform);
