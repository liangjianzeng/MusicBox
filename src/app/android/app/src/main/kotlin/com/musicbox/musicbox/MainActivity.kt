package com.musicbox.musicbox

import android.content.Intent
import com.ryanheise.audioservice.AudioServiceActivity // just_audio_background 要求宿主 Activity 继承此类（2026-11-23 K90 白屏修复）
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/// 承接 Flutter 侧的系统分享（seed-pack 配方分享）
class MainActivity : AudioServiceActivity() {
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
