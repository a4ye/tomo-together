import * as SecureStore from 'expo-secure-store';

const KEY = 'unifold_demo_uid';

function randomHex(bytes: number): string {
  let out = '';
  for (let i = 0; i < bytes; i++) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0');
  }
  return out;
}

// Returns a stable per-install external user id, creating one on first run.
// This is only an identifier (not a key), so Math.random-derived hex is fine.
export async function getOrCreateUserId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEY);
  if (existing) return existing;
  const id = 'user_' + randomHex(16);
  await SecureStore.setItemAsync(KEY, id);
  return id;
}

export async function resetUser(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
