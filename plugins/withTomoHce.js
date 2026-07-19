// Local Expo config plugin that recreates the hand-written NFC native pieces
// for Android on every `npx expo prebuild`:
//  - AndroidManifest: NFC permission, HCE feature, HostApduService entry
//  - res/xml/apduservice.xml + strings for it
//  - Kotlin sources: HceService (+ TomoHceState/TomoDiag), TomoHceModule,
//    TomoReaderModule (self-contained ISO-DEP reader; no third-party NFC lib
//    on the critical path), TomoHcePackage
//  - MainApplication.kt: manual registration of TomoHcePackage
//  - app/build.gradle: env-driven release signing (TOMO_UPLOAD_* variables)
//
// Why TomoReaderModule exists: react-native-nfc-manager v3 documents itself as
// legacy-architecture-only, and this app runs RN 0.86 new-arch/bridgeless. Its
// Android reader path (registerTagEvent -> enableReaderMode arming, plus a
// deferred bridge Callback invoked later from an NFC binder thread) has
// several silent no-op branches under the interop layer, which matched the
// field failure "nothing happens on either phone". TomoReaderModule mirrors
// Google's CardReader sample directly against the Android SDK instead.
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
import android.util.Log
import java.util.Locale

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
  // Diagnostics for the hidden overlay in ConfirmScreen.
  @Volatile var apduCount: Long = 0L
  @Volatile var lastApduHex: String = ""
  @Volatile var lastRespHex: String = ""
  @Volatile var deactivatedAt: Long = 0L
  @Volatile var deactivatedReason: Int = -1
}

/**
 * Shared diagnostics ring buffer. Written by the HCE service and by
 * TomoReaderModule; PULLED by JS via TomoReader.getLog() so the overlay works
 * even if bridge event delivery is broken. Every line is "epochMillis|text".
 */
object TomoDiag {
  private val lines = ArrayDeque<String>()

  @Synchronized
  fun log(msg: String) {
    Log.d("TomoNfc", msg)
    lines.addLast(System.currentTimeMillis().toString() + "|" + msg)
    while (lines.size > 250) lines.removeFirst()
  }

  @Synchronized
  fun snapshot(): List<String> = lines.toList()
}

private fun ByteArray.tomoHex(): String =
  joinToString("") { String.format(Locale.ROOT, "%02X", it.toInt() and 0xFF) }

/**
 * Answers ISO-DEP SELECT commands for AID ${AID} with the current payload
 * followed by SW 90 00. No length prefix and no TLV framing: the scanner
 * (TomoReaderModule / src/nfc.ts) decodes every byte before the trailing two
 * status bytes as ASCII.
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

  private fun reply(bytes: ByteArray): ByteArray {
    TomoHceState.lastRespHex = bytes.tomoHex()
    return bytes
  }

  override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray {
    TomoHceState.tappedAt = System.currentTimeMillis()
    TomoHceState.apduCount = TomoHceState.apduCount + 1
    val hex = if (commandApdu == null) "null" else commandApdu.tomoHex()
    TomoHceState.lastApduHex = hex
    TomoDiag.log("hce: apdu << " + hex)
    if (commandApdu == null || commandApdu.size < SELECT_APDU_HEADER.size) {
      TomoDiag.log("hce: not our SELECT (too short) >> 6A82")
      return reply(SW_NOT_FOUND)
    }
    for (i in SELECT_APDU_HEADER.indices) {
      if (commandApdu[i] != SELECT_APDU_HEADER[i]) {
        TomoDiag.log("hce: not our SELECT (AID mismatch) >> 6A82")
        return reply(SW_NOT_FOUND)
      }
    }
    val payload = TomoHceState.payload
    if (payload == null) {
      TomoDiag.log("hce: SELECT matched but no payload armed >> 6A82")
      return reply(SW_NOT_FOUND)
    }
    TomoHceState.servedAt = System.currentTimeMillis()
    TomoDiag.log("hce: served payload (" + payload.length + " chars) >> ...9000")
    return reply(payload.toByteArray(Charsets.US_ASCII) + SW_OK)
  }

  override fun onDeactivated(reason: Int) {
    // The payload intentionally stays readable across multiple taps until JS
    // explicitly clears it via TomoHce.clear().
    TomoHceState.deactivatedAt = System.currentTimeMillis()
    TomoHceState.deactivatedReason = reason
    val name = if (reason == DEACTIVATION_LINK_LOSS) "link-loss" else "deselected"
    TomoDiag.log("hce: deactivated (" + name + ")")
  }
}
`,
    'TomoHceModule.kt': `package ${packageName}

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class TomoHceModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "TomoHce"

  @ReactMethod
  fun setPayload(payload: String, promise: Promise) {
    TomoHceState.payload = payload
    TomoDiag.log("hce: payload armed (" + payload.length + " chars)")
    promise.resolve(null)
  }

  @ReactMethod
  fun clear(promise: Promise) {
    TomoHceState.payload = null
    TomoHceState.tappedAt = 0L
    TomoHceState.servedAt = 0L
    TomoHceState.apduCount = 0L
    TomoHceState.lastApduHex = ""
    TomoHceState.lastRespHex = ""
    TomoHceState.deactivatedAt = 0L
    TomoHceState.deactivatedReason = -1
    TomoDiag.log("hce: payload cleared")
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

  // One pull for the diagnostics overlay: everything the HCE side knows.
  @ReactMethod
  fun getDiagnostics(promise: Promise) {
    val map = Arguments.createMap()
    map.putBoolean("payloadSet", TomoHceState.payload != null)
    map.putDouble("tappedAt", TomoHceState.tappedAt.toDouble())
    map.putDouble("servedAt", TomoHceState.servedAt.toDouble())
    map.putDouble("apduCount", TomoHceState.apduCount.toDouble())
    map.putString("lastApduHex", TomoHceState.lastApduHex)
    map.putString("lastRespHex", TomoHceState.lastRespHex)
    map.putDouble("deactivatedAt", TomoHceState.deactivatedAt.toDouble())
    map.putInt("deactivatedReason", TomoHceState.deactivatedReason)
    promise.resolve(map)
  }
}
`,
    'TomoReaderModule.kt': `package ${packageName}

import android.app.Activity
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

private fun ByteArray.tomoRdrHex(): String =
  joinToString("") { String.format(Locale.ROOT, "%02X", it.toInt() and 0xFF) }

/**
 * Self-contained ISO-DEP reader for the scan side of tap-to-confirm, talking
 * straight to the Android SDK (mirrors Google's android-CardReader sample):
 *
 *   NfcAdapter.enableReaderMode(activity, callback,
 *       FLAG_READER_NFC_A or FLAG_READER_NFC_B or FLAG_READER_SKIP_NDEF_CHECK,
 *       extras)
 *
 * enableReaderMode is invoked on the main thread; onTagDiscovered arrives on a
 * binder thread where blocking IsoDep I/O is safe. Reader mode also disables
 * this device's own card emulation, which pins the two-phone roles: the
 * scanner is the reader, the shower is the card. Without it, both phones
 * advertise the same Tomo AID and the controllers pair nondeterministically.
 *
 * readOnce() keeps the reader session armed across grazing contacts and wrong
 * status words until it either reads a payload, is stopped, or times out.
 * Every step is appended to TomoDiag (pull) and mirrored as a TomoNfcEvent
 * device event (push) for the diagnostics overlay.
 */
class TomoReaderModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  companion object {
    // 00 A4 04 00 | Lc=06 | AID ${AID} | Le=00
    private val SELECT_APDU = byteArrayOf(
      0x00, 0xA4.toByte(), 0x04, 0x00, 0x06,
      0xF0.toByte(), 0x54, 0x4F, 0x4D, 0x4F, 0x31,
      0x00,
    )
  }

  private class Session(val promise: Promise, val activity: Activity) {
    val done = AtomicBoolean(false)
    var timeout: Runnable? = null
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private val lock = Any()
  private var session: Session? = null
  private var lastResult: String? = null

  override fun getName(): String = "TomoReader"

  private fun adapter(): NfcAdapter? = NfcAdapter.getDefaultAdapter(reactApplicationContext)

  private fun emit(msg: String) {
    TomoDiag.log(msg)
    try {
      val map = Arguments.createMap()
      map.putDouble("ts", System.currentTimeMillis().toDouble())
      map.putString("msg", msg)
      reactApplicationContext.emitDeviceEvent("TomoNfcEvent", map)
    } catch (t: Throwable) {
      // Diagnostics only - event plumbing must never break the reader. The
      // same line is still in TomoDiag for the pull path.
    }
  }

  // Cheap liveness + binary-freshness probe for the overlay.
  @ReactMethod
  fun ping(promise: Promise) {
    promise.resolve("tomo-reader-1")
  }

  @ReactMethod
  fun isSupported(promise: Promise) {
    promise.resolve(adapter() != null)
  }

  @ReactMethod
  fun isEnabled(promise: Promise) {
    val a = adapter()
    promise.resolve(a != null && a.isEnabled)
  }

  @ReactMethod
  fun getLog(promise: Promise) {
    val arr = Arguments.createArray()
    for (line in TomoDiag.snapshot()) arr.pushString(line)
    promise.resolve(arr)
  }

  // Rescue path: the last successful read, delivered via a fresh
  // request/response call in case a deferred promise resolution ever fails to
  // arrive in JS. Reading clears it.
  @ReactMethod
  fun takeResult(promise: Promise) {
    var r: String? = null
    synchronized(lock) {
      r = lastResult
      lastResult = null
    }
    promise.resolve(r)
  }

  @ReactMethod
  fun readOnce(timeoutMs: Double, promise: Promise) {
    val a = adapter()
    if (a == null) {
      emit("reader: no NFC adapter on this phone")
      promise.reject("no_nfc", "This phone has no NFC")
      return
    }
    if (!a.isEnabled) {
      emit("reader: NFC adapter is turned off")
      promise.reject("nfc_off", "NFC is turned off in the phone settings")
      return
    }
    // RN 0.80+ ReactContextBaseJavaModule is Kotlin: no synthetic
    // currentActivity property; the supported accessor lives on the context.
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      emit("reader: no foreground activity")
      promise.reject("no_activity", "The app is not in the foreground")
      return
    }

    val s = Session(promise, activity)
    synchronized(lock) {
      if (session != null) {
        promise.reject("busy", "A scan is already running")
        return
      }
      session = s
    }

    val timeoutRunnable = Runnable {
      finish(s, null, "timeout", "No phone was read in time")
    }
    s.timeout = timeoutRunnable
    mainHandler.postDelayed(timeoutRunnable, timeoutMs.toLong())

    mainHandler.post {
      if (s.done.get()) return@post
      try {
        val extras = Bundle()
        extras.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250)
        a.enableReaderMode(
          activity,
          NfcAdapter.ReaderCallback { tag -> onTag(s, tag) },
          NfcAdapter.FLAG_READER_NFC_A or
            NfcAdapter.FLAG_READER_NFC_B or
            NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
          extras,
        )
        emit("reader: reader mode ON (TomoReader native, A|B|skip-ndef)")
      } catch (t: Throwable) {
        emit("reader: enableReaderMode threw " + t.javaClass.simpleName + ": " + t.message)
        finish(s, null, "reader_error", "Could not switch NFC into reader mode")
      }
    }
  }

  // Binder thread: blocking I/O is safe here.
  private fun onTag(s: Session, tag: Tag) {
    val techs = tag.techList.joinToString(",") { it.substringAfterLast('.') }
    emit("reader: tag discovered techs=" + techs)
    val iso = IsoDep.get(tag)
    if (iso == null) {
      emit("reader: tag has no IsoDep, still listening")
      return
    }
    try {
      iso.connect()
      iso.setTimeout(2000)
      emit("reader: IsoDep connected, apdu >> " + SELECT_APDU.tomoRdrHex())
      val resp = iso.transceive(SELECT_APDU)
      emit("reader: apdu << " + resp.tomoRdrHex())
      if (resp.size >= 2) {
        val sw = ((resp[resp.size - 2].toInt() and 0xFF) shl 8) or
          (resp[resp.size - 1].toInt() and 0xFF)
        if (sw == 0x9000) {
          val payload = String(resp, 0, resp.size - 2, Charsets.US_ASCII)
          emit("reader: got payload (" + payload.length + " chars)")
          finish(s, payload, null, null)
          return
        }
        emit("reader: status " + String.format(Locale.ROOT, "%04X", sw) +
          " (other phone not showing a code?), still listening")
      } else {
        emit("reader: response too short, still listening")
      }
    } catch (t: Throwable) {
      emit("reader: connect/transceive failed (" + t.javaClass.simpleName + "), still listening")
    } finally {
      try {
        iso.close()
      } catch (t: Throwable) {
        // ignore
      }
    }
  }

  private fun finish(s: Session, payload: String?, errCode: String?, errMsg: String?) {
    if (!s.done.compareAndSet(false, true)) return
    synchronized(lock) {
      if (session === s) session = null
      if (payload != null) lastResult = payload
    }
    val t = s.timeout
    if (t != null) mainHandler.removeCallbacks(t)
    mainHandler.post {
      try {
        adapter()?.disableReaderMode(s.activity)
        TomoDiag.log("reader: reader mode OFF")
      } catch (x: Throwable) {
        TomoDiag.log("reader: disableReaderMode threw " + x.javaClass.simpleName)
      }
    }
    if (errCode == null) {
      s.promise.resolve(payload)
    } else {
      emit("reader: session end (" + errCode + ")")
      s.promise.reject(errCode, errMsg)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    var s: Session? = null
    synchronized(lock) { s = session }
    val active = s
    if (active != null) finish(active, null, "cancelled", "Scan was cancelled")
    promise.resolve(null)
  }

  @Suppress("UNUSED_PARAMETER")
  @ReactMethod
  fun addListener(eventName: String) {
    // Required stub for NativeEventEmitter compatibility.
  }

  @Suppress("UNUSED_PARAMETER")
  @ReactMethod
  fun removeListeners(count: Int) {
    // Required stub for NativeEventEmitter compatibility.
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
    listOf(TomoHceModule(reactContext), TomoReaderModule(reactContext))

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
