/* eslint-env node */

// Fork (VRCX-Headless): .NET RID OS prefix for the host building this package.
// Upstream copies from `build/Electron/${os}-${arch}/`, but electron-builder's
// ${os} macro expands to "mac" on macOS while the .NET output folder is
// "osx-<arch>" (the RID), so the macOS build would package no .NET backend.
// Every release leg packages on its own native OS, so the host platform is
// the target platform. Same mapping as src-electron/main.js's getRid().
const ridOs = { win32: 'win', darwin: 'osx', linux: 'linux' }[process.platform];

/**
 * @type {import('electron-builder').Configuration}
 * @see https://www.electron.build/configuration/configuration
 */
module.exports = {
    appId: 'app.vrcx',
    productName: 'VRCX Headless',
    icon: 'images/VRCX.png',
    files: [
        'build/html/**/*',
        'src-electron/*',
        'client-desktop/setup.html',
        'client-desktop/setup.js',
        'client-desktop/splash.html',
        'client-desktop/splash.js',
        'node_modules/qrcode-generator/dist/qrcode.js',
        'images/VRCX.png',
        'images/VRCX.ico',
        'images/VRCX_notify.png',
        'images/VRCX_notify.ico',
        'Version',
        'src-electron/libs/linux/libopenvr_api.so',
        '.no-updater'
    ],
    asarUnpack: [
        'node_modules/node-api-dotnet/**/*',
        'node_modules/node-api-dotnet/net10.0/**/*',
        'build/Electron/*',
        'build/Electron/**',
        'build/Electron/dotnet-runtime/**/*',
        'src-electron/libs/linux/libopenvr_api.so'
    ],
    extraResources: [
        {
            from: `build/Electron/${ridOs}-\${arch}/`,
            to: 'app.asar.unpacked/build/Electron/'
        },
        {
            from: 'node_modules/node-api-dotnet/net10.0/Microsoft.JavaScript.NodeApi.dll',
            to: 'app.asar.unpacked/node_modules/node-api-dotnet/net10.0/Microsoft.JavaScript.NodeApi.dll'
        },
        {
            from: 'node_modules/node-api-dotnet/net10.0/Microsoft.JavaScript.NodeApi.DotNetHost.dll',
            to: 'app.asar.unpacked/node_modules/node-api-dotnet/net10.0/Microsoft.JavaScript.NodeApi.DotNetHost.dll'
        },
        {
            from: 'build/Electron/dotnet-runtime/',
            to: 'dotnet-runtime/'
        },
        {
            from: 'src-electron/libs/linux/libopenvr_api.so',
            to: 'bin/libopenvr_api.so'
        },
        {
            from: 'src-electron/libs/linux/libopenvr_api.so',
            to: 'app.asar.unpacked/build/Electron/openvr_api.so'
        }
    ],
    directories: {
        output: 'build'
    },
    linux: {
        artifactName: 'VRCX-Headless_Version.${ext}',
        target: ['AppImage'],
        icon: 'images/VRCX.png',
        executableName: 'VRCX',
        mimeTypes: ['x-scheme-handler/vrcx'],
        desktop: {
            entry: {
                Name: 'VRCX Headless Desktop',
                Comment: 'Friendship management tool for VRChat (VRCX-Headless fork client)',
                Icon: 'VRCX',
                Terminal: 'false',
                Type: 'Application',
                Categories: 'Utility;Application;',
                StartupWMClass: 'VRCX',
                MimeType: 'x-scheme-handler/vrcx;'
            }
        },
        maintainer: 'WentTheFox <mail@went.tf>',
        description: 'Friendship management tool for VRChat (VRCX-Headless fork client)',
        syncDesktopName: true
    },
    mac: {
        artifactName: 'VRCX-Headless_Version.${ext}',
        target: ['dmg'],
        icon: 'images/VRCX.png',
        category: 'public.app-category.utilities',
        executableName: 'VRCX',
        minimumSystemVersion: '14.0'
    },
    toolsets: {
        appimage: '1.0.3'
    }
};
