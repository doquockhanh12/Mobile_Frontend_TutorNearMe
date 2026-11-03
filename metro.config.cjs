// Permit bundling the opaque binary Regula license as a local asset.
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.resolver.assetExts = Array.from(new Set([...config.resolver.assetExts, 'license']));
module.exports = config;
