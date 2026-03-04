# Ts2Hls - 直播流转码工具

将 TS 协议直播流转换为 HLS 格式，支持生成 M3U 订阅地址，并提供可视化 Web 管理界面。

## 主要功能

- TS 直播流转 HLS，按需拉流，降低资源占用
- M3U 文件导入（本地上传/拖拽）
- M3U 订阅链接导入（HTTP/HTTPS）
- 清除已导入数据（一键清空频道映射、订阅文件、图标与临时转流数据）
- Web 端直播预览与播放控制（含停止预览）
- 输出统一订阅文件：`/playlist/ts2hls.m3u`

## Docker Compose 示例

```yaml
services:
  ts2hls:
    image: zsw01442/ts2hls:latest
    container_name: ts2hls
    restart: unless-stopped
    ports:
      - "15140:15140"
    volumes:
      - ./m3u:/app/m3u
    tmpfs:
      - /app/hls_temp:size=512M,mode=1777,exec
    environment:
      - TZ=Asia/Shanghai
```

启动：

```bash
docker compose up -d
```

访问管理界面：

```text
http://<服务器IP>:15140
```

## 版本

当前版本：`1.3.4`
