import * as Application from 'expo-application';
import {
  cacheDirectory, createDownloadResumable, getContentUriAsync,
} from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';

export type UpdateInfo = { versionCode: number; versionName: string };

export function currentBuild(): number {
  return Number(Application.nativeBuildVersion ?? 0);
}

// CI publishes { versionCode, versionName } next to the APK; the server
// serves it at /apk/version. Returns the update info when the server has
// a newer build than the one running.
export async function checkForUpdate(serverUrl: string): Promise<UpdateInfo | null> {
  if (__DEV__ || Platform.OS !== 'android') return null;
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8000);
    const res = await fetch(`${serverUrl}/apk/version`, { signal: abort.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const info = (await res.json()) as UpdateInfo;
    if (typeof info.versionCode !== 'number') return null;
    return info.versionCode > currentBuild() ? info : null;
  } catch {
    return null;
  }
}

// Downloads the APK and hands it to the Android package installer.
// The user confirms the install in the system dialog; on first use Android
// asks once to allow installs from this app.
export async function downloadAndInstall(
  serverUrl: string,
  onProgress: (fraction: number) => void
): Promise<void> {
  const dest = `${cacheDirectory}tomo-yard-update.apk`;
  const dl = createDownloadResumable(`${serverUrl}/apk`, dest, {}, (p) => {
    if (p.totalBytesExpectedToWrite > 0) {
      onProgress(p.totalBytesWritten / p.totalBytesExpectedToWrite);
    }
  });
  const result = await dl.downloadAsync();
  if (!result || (result.status !== 200 && result.status !== 0)) {
    throw new Error('Download failed, try again');
  }
  const contentUri = await getContentUriAsync(result.uri);
  await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
    data: contentUri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
  });
}
