package com.musicbox.musicbox

import android.content.Intent
import android.os.Bundle
import com.ryanheise.audioservice.AudioServiceActivity // just_audio_background 要求宿主 Activity 继承此类（2026-11-23 K90 白屏修复）
import com.ryanheise.audioservice.AudioServicePlugin
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.FlutterEngineCache
import io.flutter.embedding.engine.FlutterJNI
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.embedding.engine.loader.FlutterLoader
import io.flutter.plugin.common.MethodChannel

/// 承接 Flutter 侧的系统分享（seed-pack 配方分享）
class MainActivity : AudioServiceActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // K90 (M332BF) 的 Adreno Vulkan 驱动在 CmdEndRenderPass 空指针崩溃。
        // Flutter 3.27 的 --impeller-backend 仅 Debug/Profile 生效，Release 忽略；
        // Release 下关闭 Impeller 即回退到 Skia OpenGLES（仍 GPU 加速），绕开 Vulkan 驱动。
        // audio_service 会复用缓存引擎，故在 super.onCreate 前用真实 shell args 预建引擎。
        if (android.os.Build.MODEL.equals("M332BF", ignoreCase = true) &&
            FlutterEngineCache.getInstance().get(AudioServicePlugin.getFlutterEngineId()) == null
        ) {
            val appContext = applicationContext
            val jni = FlutterJNI()
            val loader = FlutterLoader(jni)
            loader.startInitialization(appContext)
            loader.ensureInitializationComplete(appContext, arrayOf("--enable-impeller=false"))
            val engine = FlutterEngine(appContext, loader, jni)
            engine.navigationChannel.setInitialRoute("/")
            engine.dartExecutor.executeDartEntrypoint(
                DartExecutor.DartEntrypoint(loader.findAppBundlePath(), "main")
            )
            FlutterEngineCache.getInstance().put(AudioServicePlugin.getFlutterEngineId(), engine)
        }
        super.onCreate(savedInstanceState)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "musicbox/share"
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "shareText" -> {
                    val text = call.argument<String>("text") ?: ""
                    val intent = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_TEXT, text)
                    }
                    startActivity(Intent.createChooser(intent, "分享"))
                    result.success(true)
                }
                else -> result.notImplemented()
            }
        }
    }
}
