package com.wzx.wzxclaw_android

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

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

		// 文件下载桥：preview 调系统查看器预览缓存临时文件；save 写入公共
		// 下载文件夹。只传文件路径不过字节，避免大文件经通道双重拷贝。
		MethodChannel(
			flutterEngine.dartExecutor.binaryMessenger,
			"wzxclaw_android/downloads"
		).setMethodCallHandler { call, result ->
			when (call.method) {
				"preview" -> {
					val path = call.argument<String>("path")
					val mime = call.argument<String>("mime") ?: "application/octet-stream"
					if (path == null) {
						result.error("bad-args", "path required", null)
					} else {
						result.success(openPreview(File(path), mime))
					}
				}

				"save" -> {
					val name = call.argument<String>("name")
					val mime = call.argument<String>("mime") ?: "application/octet-stream"
					val srcPath = call.argument<String>("srcPath")
					if (name == null || srcPath == null) {
						result.error("bad-args", "name/srcPath required", null)
					} else {
						result.success(saveToDownloads(name, mime, File(srcPath)))
					}
				}

				else -> result.notImplemented()
			}
		}
	}

	/**
	 * FileProvider content:// + ACTION_VIEW 调起外部查看器。
	 * 不调 resolveActivity（Android 11+ 包可见性过滤会误判），
	 * 直接 startActivity 并捕获 ActivityNotFoundException。
	 */
	private fun openPreview(file: File, mime: String): Map<String, Any> {
		if (!file.exists()) {
			return mapOf("ok" to false, "reason" to "no-file")
		}
		val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
		val intent = Intent(Intent.ACTION_VIEW).apply {
			setDataAndType(uri, mime)
			addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
		}
		return try {
			startActivity(intent)
			mapOf("ok" to true)
		} catch (e: ActivityNotFoundException) {
			mapOf("ok" to false, "reason" to "no-handler")
		}
	}

	/**
	 * 保存到公共下载文件夹（MediaStore.Downloads，免存储权限，同名由系统
	 * 自动加后缀）。仅支持 Android 10+：更低版本没有 MediaStore.Downloads，
	 * 显式报 unsupported（设计原则：宁可显式报暂不支持，不做降级假保存）。
	 */
	private fun saveToDownloads(name: String, mime: String, src: File): Map<String, Any> {
		if (!src.exists()) {
			return mapOf("ok" to false, "reason" to "no-file")
		}
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
			return mapOf("ok" to false, "reason" to "unsupported")
		}
		val values = ContentValues().apply {
			put(MediaStore.Downloads.DISPLAY_NAME, name)
			put(MediaStore.Downloads.MIME_TYPE, mime)
			put(MediaStore.Downloads.IS_PENDING, 1)
		}
		val resolver = contentResolver
		val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
			?: return mapOf("ok" to false, "reason" to "insert-failed")
		try {
			resolver.openOutputStream(uri)?.use { out ->
				src.inputStream().use { it.copyTo(out) }
			} ?: return mapOf("ok" to false, "reason" to "stream-open-failed")
		} catch (e: Exception) {
			resolver.delete(uri, null, null)
			return mapOf("ok" to false, "reason" to "write-failed")
		}
		values.clear()
		values.put(MediaStore.Downloads.IS_PENDING, 0)
		resolver.update(uri, values, null, null)
		return mapOf("ok" to true, "uri" to uri.toString())
	}
}
