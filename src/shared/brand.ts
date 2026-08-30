export const APP_NAME = 'Amy-PPT'
export const APP_PACKAGE_NAME = 'amy-ppt'
export const APP_ID = 'com.amyppt.app'
export const APP_VERSION = '1.0.5'
export const APP_REPOSITORY_URL = 'https://github.com/296711867/Amy-PPT'
export const APP_RELEASES_URL = `${APP_REPOSITORY_URL}/releases`
export const DEFAULT_UPDATE_MANIFEST_URL =
  'https://raw.githubusercontent.com/296711867/Amy-PPT/main/version.json'

export const resolveUpdateManifestUrl = (
  environment: Record<string, string | undefined> = process.env
): string => String(environment.AMY_PPT_UPDATE_MANIFEST_URL || DEFAULT_UPDATE_MANIFEST_URL).trim()
