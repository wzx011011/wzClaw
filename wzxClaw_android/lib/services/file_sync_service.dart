import 'dart:async';

import '../models/ws_message.dart';
import '../models/connection_state.dart';
import 'connection_manager.dart';

/// A node in the file tree received from the desktop.
class FileTreeNode {
  final String name;
  final String path;
  final bool isDirectory;
  final List<FileTreeNode> children;
  bool isExpanded;

  FileTreeNode({
    required this.name,
    required this.path,
    required this.isDirectory,
    List<FileTreeNode>? children,
    this.isExpanded = false,
  }) : children = children ?? [];

  factory FileTreeNode.fromJson(Map<String, dynamic> json) {
    final children = (json['children'] as List?)
            ?.map(
              (c) => FileTreeNode.fromJson(
                Map<String, dynamic>.from(c as Map),
              ),
            )
            .toList() ??
        [];
    return FileTreeNode(
      name: json['name'] as String? ?? '',
      path: json['path'] as String? ?? '',
      isDirectory: json['isDirectory'] as bool? ?? false,
      children: children,
    );
  }
}

/// File content received from the desktop.
class FileContent {
  final String content;
  final String language;
  final int size;
  final String filePath;

  const FileContent({
    required this.content,
    required this.language,
    required this.size,
    required this.filePath,
  });
}

/// Singleton service for browsing desktop workspace files.
class FileSyncService {
  static final FileSyncService _instance = FileSyncService._();
  static FileSyncService get instance => _instance;
  FileSyncService._() {
    _init();
  }

  StreamSubscription<WsMessage>? _wsSubscription;
  StreamSubscription<WsConnectionState>? _connectionStateSub;
  int _requestCounter = 0;
  final Map<String, Completer<dynamic>> _pendingRequests = {};

  final _treeController = StreamController<List<FileTreeNode>>.broadcast();
  Stream<List<FileTreeNode>> get treeStream => _treeController.stream;
  List<FileTreeNode> _tree = [];
  List<FileTreeNode> get tree => _tree;

  void _init() {
    _wsSubscription =
        ConnectionManager.instance.messageStream.listen(_handleWsMessage);
    // Clear stale tree data on disconnect.
    _connectionStateSub =
        ConnectionManager.instance.stateStream.listen((state) {
      if (state == WsConnectionState.disconnected) {
        _tree = [];
        if (!_treeController.isClosed) _treeController.add([]);
      }
    });
  }

  void _handleWsMessage(WsMessage msg) {
    switch (msg.event) {
      case WsEvents.fileTreeResponse:
        _handleTreeResponse(msg.data);
        break;
      case WsEvents.fileReadResponse:
        _handleReadResponse(msg.data);
        break;
    }
  }

  void _handleTreeResponse(dynamic data) {
    if (data is! Map) return;
    final requestId = data['requestId'] as String? ?? '';
    final rawNodes = data['nodes'] as List? ?? [];
    final nodes = rawNodes
        .whereType<Map>()
        .map((n) => FileTreeNode.fromJson(Map<String, dynamic>.from(n)))
        .toList();
    _tree = nodes;
    _treeController.add(List.unmodifiable(_tree));
    _completePending(requestId, nodes);
  }

  void _handleReadResponse(dynamic data) {
    if (data is! Map) return;
    final requestId = data['requestId'] as String? ?? '';
    print('[FileSync] read response: requestId=$requestId, error=${data['error']}, hasContent=${data['content'] != null}');
    if (data['error'] != null) {
      _completePending(requestId, null, error: data['error'] as String);
      return;
    }
    final content = FileContent(
      content: data['content'] as String? ?? '',
      language: data['language'] as String? ?? '',
      size: (data['size'] as num?)?.toInt() ?? 0,
      filePath: data['filePath'] as String? ?? '',
    );
    _completePending(requestId, content);
  }

  /// Fetch directory tree from the desktop.
  Future<List<FileTreeNode>> fetchTree({String? dirPath, int depth = 2}) async {
    if (ConnectionManager.instance.state != WsConnectionState.connected) {
      return [];
    }
    final requestId = _nextRequestId();
    final completer = Completer<dynamic>();
    _pendingRequests[requestId] = completer;

    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.fileTreeRequest,
      data: {
        'requestId': requestId,
        if (dirPath != null) 'dirPath': dirPath,
        'depth': depth,
      },
    ),);

    Future.delayed(const Duration(seconds: 10), () {
      if (!completer.isCompleted) {
        _pendingRequests.remove(requestId);
        completer.completeError('Timeout fetching file tree');
      }
    });

    final result = await completer.future;
    if (result is List<FileTreeNode>) return result;
    return [];
  }

  /// Read a file's content from the desktop.
  Future<FileContent?> readFile(String filePath) async {
    if (ConnectionManager.instance.state != WsConnectionState.connected) {
      throw '未连接到桌面端';
    }
    final requestId = _nextRequestId();
    final completer = Completer<dynamic>();
    _pendingRequests[requestId] = completer;

    print('[FileSync] sending file:read:request for $filePath');

    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.fileReadRequest,
      data: {
        'requestId': requestId,
        'filePath': filePath,
      },
    ),);

    Future.delayed(const Duration(seconds: 10), () {
      if (!completer.isCompleted) {
        _pendingRequests.remove(requestId);
        completer.completeError('Timeout reading file');
      }
    });

    final result = await completer.future;
    if (result is FileContent) return result;
    return null;
  }

  String _nextRequestId() {
    _requestCounter++;
    return 'file_req_${DateTime.now().millisecondsSinceEpoch}_$_requestCounter';
  }

  void _completePending(String requestId, dynamic result, {String? error}) {
    final completer = _pendingRequests.remove(requestId);
    if (completer != null && !completer.isCompleted) {
      if (error != null) {
        completer.completeError(error);
      } else {
        completer.complete(result);
      }
    }
  }

  void dispose() {
    _wsSubscription?.cancel();
    _connectionStateSub?.cancel();
    _treeController.close();
  }
}
