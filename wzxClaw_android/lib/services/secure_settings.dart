import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

class SecureSettings {
  SecureSettings._();

  static const _authTokenKey = 'auth_token';
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  static Future<String> getAuthToken() async {
    final secureValue = await _storage.read(key: _authTokenKey);
    if (secureValue != null && secureValue.isNotEmpty) return secureValue;

    final prefs = await SharedPreferences.getInstance();
    final legacyValue = prefs.getString(_authTokenKey) ?? '';
    if (legacyValue.isNotEmpty) {
      await setAuthToken(legacyValue);
      await prefs.remove(_authTokenKey);
    }
    return legacyValue;
  }

  static Future<void> setAuthToken(String token) async {
    final trimmed = token.trim();
    if (trimmed.isEmpty) {
      await _storage.delete(key: _authTokenKey);
      return;
    }
    await _storage.write(key: _authTokenKey, value: trimmed);
  }
}