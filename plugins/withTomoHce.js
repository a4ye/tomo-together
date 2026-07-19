// Local Expo config plugin that recreates the hand-written NFC HCE native pieces
// for Android on every `npx expo prebuild`:
//  - AndroidManifest: NFC permission, HCE feature, HostApduService entry
//  - res/xml/apduservice.xml + strings for it
//  - Kotlin sources: HceService, TomoHceModule, TomoHcePackage
//  - MainApplication.kt: manual registration of TomoHcePackage
//  - app/build.gradle: env-driven release signing (TOMO_UPLOAD_* variables)
const { promises: fs } = require('fs');
const path = require('path');
const {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withMainApplication,
  withStringsXml,
} = require('expo/config-plugins');

// Must match the AID used by the scanner in src/nfc.ts.
const AID = 'F0544F4D4F31';

const APDU_SERVICE_XML = `<host-apdu-service xmlns:android="http://schemas.android.com/apk/res/android" android:description="@string/hce_service_desc" android:requireDeviceUnlock="false">
  <aid-group android:category="other" android:description="@string/hce_aid_group_desc">
    <aid-filter android:name="${AID}"/>
  </aid-group>
</host-apdu-service>
`;

function getPackageName(config) {
  const pkg = config.android && config.android.package;
  if (!pkg) {
    throw new Error('withTomoHce: android.package must be set in app.json');
  }
  return pkg;
}

function kotlinSources(packageName) {
  return {
    'HceService.kt': `package ${packageName}

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/**
 * In-process shared state between the React Native module (writer) and the
 * HCE service (reader). Both run in the main app process.
 */
object TomoHceState {
  @Volatile var payload: String? = null
  // Set every time a reader phone makes radio contact; lets the UI show
  // "phones touched" feedback while waiting for the confirm round-trip.
  @Volatile var tappedAt: Long = 0L
  // Set only when the payload was actually returned to a reader with SW 9000.
  // tappedAt without servedAt = contact happened but the SELECT never matched
  // or no payload was set - that distinction pinpoints where a tap died.
  @Volatile var servedAt: Long = 0L
}

/**
 * Answers ISO-DEP SELECT commands for AID ${AID} with the current payload
 * followed by SW 90 00. No length prefix and no TLV framing: the scanner in
 * src/nfc.ts does String.fromCharCode over every byte before the trailing
 * two status bytes.
 */
class HceService : HostApduService() {

  companion object {
    // 00 A4 04 00 06 + AID bytes -> SELECT by AID ${AID}
    private val SELECT_APDU_HEADER = byteArrayOf(
      0x00, 0xA4.toByte(), 0x04, 0x00, 0x06,
      0xF0.toByte(), 0x54, 0x4F, 0x4D, 0x4F, 0x31,
    )
    private val SW_OK = byteArrayOf(0x90.toByte(), 0x00)
    private val SW_NOT_FOUND = byteArrayOf(0x6A, 0x82.toByte())
  }

  override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray {
    TomoHceState.tappedAt = System.currentTimeMillis()
    if (commandApdu == null || commandApdu.size < SELECT_APDU_HEADER.size) {
      return SW_NOT_FOUND
    }
    for (i in SELECT_APDU_HEADER.indices) {
      if (commandApdu[i] != SELECT_APDU_HEADER[i]) {
        return SW_NOT_FOUND
      }
    }
    val payload = TomoHceState.payload ?: return SW_NOT_FOUND
    TomoHceState.servedAt = System.currentTimeMillis()
    return payload.toByteArray(Charsets.US_ASCII) + SW_OK
  }

  override fun onDeactivated(reason: Int) {
    // Intentionally empty: the payload must stay readable across multiple
    // taps until JS explicitly clears it via TomoHce.clear().
  }
}
`,
    'TomoHceModule.kt': `package ${packageName}

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class TomoHceModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "TomoHce"

  @ReactMethod
  fun setPayload(payload: String, promise: Promise) {
    TomoHceState.payload = payload
    promise.resolve(null)
  }

  @ReactMethod
  fun clear(promise: Promise) {
    TomoHceState.payload = null
    TomoHceState.tappedAt = 0L
    TomoHceState.servedAt = 0L
    promise.resolve(null)
  }

  @ReactMethod
  fun lastTapAt(promise: Promise) {
    promise.resolve(TomoHceState.tappedAt.toDouble())
  }

  @ReactMethod
  fun lastServedAt(promise: Promise) {
    promise.resolve(TomoHceState.servedAt.toDouble())
  }
}
`,
    'TomoHcePackage.kt': `package ${packageName}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class TomoHcePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(TomoHceModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
`,
  };
}

// --- AndroidManifest.xml -----------------------------------------------------

function withTomoHceManifest(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    manifest['uses-permission'] = manifest['uses-permission'] || [];
    if (
      !manifest['uses-permission'].some(
        (p) => p.$['android:name'] === 'android.permission.NFC'
      )
    ) {
      manifest['uses-permission'].push({
        $: { 'android:name': 'android.permission.NFC' },
      });
    }

    manifest['uses-feature'] = manifest['uses-feature'] || [];
    if (
      !manifest['uses-feature'].some(
        (f) => f.$['android:name'] === 'android.hardware.nfc.hce'
      )
    ) {
      manifest['uses-feature'].push({
        $: {
          'android:name': 'android.hardware.nfc.hce',
          'android:required': 'false',
        },
      });
    }

    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    // allow plain-http servers for local development (production uses https)
    app.$['android:usesCleartextTraffic'] = 'true';
    app.service = app.service || [];
    if (!app.service.some((s) => s.$['android:name'] === '.HceService')) {
      app.service.push({
        $: {
          'android:name': '.HceService',
          'android:exported': 'true',
          'android:permission': 'android.permission.BIND_NFC_SERVICE',
        },
        'intent-filter': [
          {
            action: [
              {
                $: {
                  'android:name':
                    'android.nfc.cardemulation.action.HOST_APDU_SERVICE',
                },
              },
            ],
          },
        ],
        'meta-data': [
          {
            $: {
              'android:name': 'android.nfc.cardemulation.host_apdu_service',
              'android:resource': '@xml/apduservice',
            },
          },
        ],
      });
    }
    return config;
  });
}

// --- strings.xml -------------------------------------------------------------

function withTomoHceStrings(config) {
  return withStringsXml(config, (config) => {
    config.modResults = AndroidConfig.Strings.setStringItem(
      [
        { $: { name: 'hce_service_desc' }, _: 'Tomo Yard tap sharing' },
        { $: { name: 'hce_aid_group_desc' }, _: 'Tomo Yard' },
      ],
      config.modResults
    );
    return config;
  });
}

// --- res/xml/apduservice.xml + Kotlin sources --------------------------------

function withTomoHceFiles(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const platformRoot = config.modRequest.platformProjectRoot;
      const packageName = getPackageName(config);

      const xmlDir = path.join(platformRoot, 'app', 'src', 'main', 'res', 'xml');
      await fs.mkdir(xmlDir, { recursive: true });
      await fs.writeFile(path.join(xmlDir, 'apduservice.xml'), APDU_SERVICE_XML);

      const javaDir = path.join(
        platformRoot,
        'app',
        'src',
        'main',
        'java',
        ...packageName.split('.')
      );
      await fs.mkdir(javaDir, { recursive: true });
      const sources = kotlinSources(packageName);
      for (const [fileName, contents] of Object.entries(sources)) {
        await fs.writeFile(path.join(javaDir, fileName), contents);
      }
      return config;
    },
  ]);
}

// --- MainApplication.kt ------------------------------------------------------

function patchMainApplication(contents) {
  if (contents.includes('TomoHcePackage()')) {
    return contents;
  }
  // SDK 57 Kotlin template:
  //   PackageList(this).packages.apply {
  //     // Packages that cannot be autolinked yet can be added manually here, for example:
  //     // add(MyReactNativePackage())
  //   }
  const applyAnchor = /(PackageList\(this\)\.packages\.apply\s*\{)/;
  if (applyAnchor.test(contents)) {
    return contents.replace(applyAnchor, '$1\n          add(TomoHcePackage())');
  }
  // Older template shape:
  //   val packages = PackageList(this).packages
  const legacyAnchor = /(val packages\s*(?::\s*[\w<>., ?*]+)?=\s*PackageList\(this\)\.packages)/;
  if (legacyAnchor.test(contents)) {
    return contents.replace(legacyAnchor, '$1\n            packages.add(TomoHcePackage())');
  }
  throw new Error(
    'withTomoHce: could not find the package list in MainApplication - template changed?'
  );
}

function withTomoHceMainApplication(config) {
  return withMainApplication(config, (config) => {
    config.modResults.contents = patchMainApplication(config.modResults.contents);
    return config;
  });
}

// --- app/build.gradle release signing ----------------------------------------

function patchAppBuildGradle(contents) {
  if (contents.includes('TOMO_UPLOAD_STORE_FILE')) {
    return contents;
  }

  const releaseSigningConfig = `        release {
            if (System.getenv("TOMO_UPLOAD_STORE_FILE")) {
                storeFile file(System.getenv("TOMO_UPLOAD_STORE_FILE"))
                storePassword System.getenv("TOMO_UPLOAD_STORE_PASSWORD")
                keyAlias System.getenv("TOMO_UPLOAD_KEY_ALIAS")
                keyPassword System.getenv("TOMO_UPLOAD_KEY_PASSWORD")
            }
        }
`;

  let out = contents.replace(
    /signingConfigs\s*\{\s*\n/,
    (match) => match + releaseSigningConfig
  );
  if (!out.includes('TOMO_UPLOAD_STORE_FILE')) {
    throw new Error(
      'withTomoHce: could not find signingConfigs block in app/build.gradle'
    );
  }

  // Point ONLY the release build type at the new config (when the env var is
  // set). Anchored on the template comment that exists solely in the release
  // build type, so the debug build type keeps its debug signing untouched.
  const releaseAnchor =
    /(\/\/ see https:\/\/reactnative\.dev\/docs\/signed-apk-android\.\s*\r?\n\s*)signingConfig signingConfigs\.debug/;
  if (!releaseAnchor.test(out)) {
    throw new Error(
      'withTomoHce: could not find release signingConfig line in app/build.gradle'
    );
  }
  out = out.replace(
    releaseAnchor,
    '$1signingConfig System.getenv("TOMO_UPLOAD_STORE_FILE") ? signingConfigs.release : signingConfigs.debug'
  );
  return out;
}

function withTomoHceSigning(config) {
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = patchAppBuildGradle(config.modResults.contents);
    return config;
  });
}

// --- entry point -------------------------------------------------------------

function withTomoHce(config) {
  config = withTomoHceManifest(config);
  config = withTomoHceStrings(config);
  config = withTomoHceFiles(config);
  config = withTomoHceMainApplication(config);
  config = withTomoHceSigning(config);
  return config;
}

module.exports = withTomoHce;
