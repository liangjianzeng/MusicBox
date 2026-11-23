# MusicBox App（Flutter）

Android 优先的 Flutter 客户端（Riverpod + dio + just_audio_background/audio_service + record + image_picker），对接仓库根目录的零依赖 Node 服务端（契约见 [../../CONTRACTS.md](../../CONTRACTS.md)）。

```bash
flutter pub get
flutter run                    # 模拟器默认连 http://10.0.2.2:7900；真机在「服务器设置」填宿主可达地址
flutter build apk --release    # 签名读 android/key.properties（本地自建，勿入仓；缺失回落 debug 签名）
flutter test
```

目录：`lib/core`（api/ws/状态/配置）、`lib/features`（auth/create/library/persona/player/me，create 含傻瓜/标准/深度三档壳与意图流）、`lib/shared`（波形画布/AI 徽章/同意书等）。

后台播放三件套（白屏教训，2026-11-23）：`MainActivity extends AudioServiceActivity` + Manifest 声明 `AudioService`(mediaPlayback FGS)/`MediaButtonReceiver` + `FOREGROUND_SERVICE(_MEDIA_PLAYBACK)` 权限，缺一即 `AudioService.init` 抛异常导致 runApp 不执行。
