# Ts2Hls - 鐩存挱娴佽浆鐮佸伐鍏?
灏?TS 鍗忚鐩存挱娴佽浆鎹负 HLS 鏍煎紡锛屾敮鎸佺敓鎴?M3U 璁㈤槄鍦板潃锛屽苟鎻愪緵鍙鍖?Web 绠＄悊鐣岄潰銆?
## 涓昏鍔熻兘

- TS 鐩存挱娴佽浆 HLS锛屾寜闇€鎷夋祦锛岄檷浣庤祫婧愬崰鐢?- M3U 鏂囦欢瀵煎叆锛堟湰鍦颁笂浼?鎷栨嫿锛?- M3U 璁㈤槄閾炬帴瀵煎叆锛圚TTP/HTTPS锛?- Web 绔洿鎾瑙堜笌鎾斁鎺у埗锛堝惈鍋滄棰勮锛?- 杈撳嚭缁熶竴璁㈤槄鏂囦欢锛歚/playlist/ts2hls.m3u`

## Docker Compose 绀轰緥

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

鍚姩锛?
```bash
docker compose up -d
```

璁块棶绠＄悊鐣岄潰锛?
```text
http://<鏈嶅姟鍣↖P>:15140
```

## 鐗堟湰

褰撳墠鐗堟湰锛歚1.3.1`

