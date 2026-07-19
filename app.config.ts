import type { ConfigContext, ExpoConfig } from 'expo/config';

const AUTH0_SCHEME = 'tomoyard';
const APP_ID = 'com.anonymous.friendsthing';

function normalizeDomain(value: string | undefined): string {
  return (value ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const domain = normalizeDomain(process.env.EXPO_PUBLIC_AUTH0_DOMAIN);
  const plugins = (config.plugins ?? []).filter((plugin) => {
    const name = Array.isArray(plugin) ? plugin[0] : plugin;
    return name !== 'react-native-auth0';
  });

  // The native callback must be generated with the same tenant domain used at
  // runtime. An unconfigured checkout still supports `expo config` and web
  // export, while configured development/EAS builds receive the Auth0 plugin.
  if (domain) {
    plugins.push(['react-native-auth0', { domain, customScheme: AUTH0_SCHEME }]);
  }

  return {
    ...config,
    name: config.name ?? 'Tomo Yard',
    slug: config.slug ?? 'friends-thing',
    scheme: AUTH0_SCHEME,
    ios: {
      ...config.ios,
      bundleIdentifier: APP_ID,
    },
    android: {
      ...config.android,
      package: APP_ID,
    },
    plugins,
  };
};
