package com.wzx.wzxclaw_android

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity: FlutterActivity() {
	override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
		super.configureFlutterEngine(flutterEngine)

		MethodChannel(
			flutterEngine.dartExecutor.binaryMessenger,
			"wzxclaw_android/foreground_keepalive"
		).setMethodCallHandler { call, result ->
			when (call.method) {
				"startForegroundKeepAlive" -> {
					KeepAliveForegroundService.start(this)
					result.success(true)
				}

				"stopForegroundKeepAlive" -> {
					KeepAliveForegroundService.stop(this)
					result.success(true)
				}

				else -> result.notImplemented()
			}
		}
	}
}
