package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"ts2hls/manager"
	"ts2hls/parser"

	"github.com/shirou/gopsutil/v3/cpu"
)

var pm *manager.ProcessManager

const (
	Port         = "15140"
	TempDir      = "hls_temp"
	AppName      = "Ts2Hls"
	AppVersion   = "1.3.3"
	PlaylistName = "ts2hls.m3u"
	maxM3UBytes  = 20 * 1024 * 1024
)

func main() {
	pm = manager.NewProcessManager()

	_ = os.MkdirAll(TempDir, 0755)
	_ = os.MkdirAll(filepath.Join("m3u", "logos"), 0755)

	staticFS := http.FileServer(http.Dir(filepath.Join("web", "static")))
	http.Handle("/static/", http.StripPrefix("/static/", staticFS))

	logoFS := http.FileServer(http.Dir(filepath.Join("m3u", "logos")))
	http.Handle("/logos/", http.StripPrefix("/logos/", logoFS))

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.ServeFile(w, r, filepath.Join("web", "index.html"))
			return
		}
		http.NotFound(w, r)
	})

	http.HandleFunc("/api/upload", uploadHandler)
	http.HandleFunc("/api/upload/url", uploadURLHandler)
	http.HandleFunc("/api/data/clear", clearDataHandler)
	http.HandleFunc("/api/list", listHandler)
	http.HandleFunc("/api/status", statusHandler)
	http.HandleFunc("/api/config", configHandler)

	http.HandleFunc("/playlist/"+PlaylistName, playlistHandler)
	http.HandleFunc("/stream/", streamHandler)

	fmt.Println("-------------------------------------------")
	fmt.Printf("%s v%s 服务已启动\n", AppName, AppVersion)
	fmt.Printf("管理界面: http://127.0.0.1:%s\n", Port)
	fmt.Printf("订阅地址: http://127.0.0.1:%s/playlist/%s\n", Port, PlaylistName)
	fmt.Println("-------------------------------------------")

	log.Fatal(http.ListenAndServe(":"+Port, nil))
}

func getSystemStats() (string, string) {
	cpuPercent, _ := cpu.Percent(200*time.Millisecond, false)
	cpuStr := "0.0"
	if len(cpuPercent) > 0 {
		cpuStr = fmt.Sprintf("%.1f", cpuPercent[0])
	}

	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	memUsed := fmt.Sprintf("%d", m.Sys/1024/1024)

	return cpuStr, memUsed
}

func configHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodGet {
		_ = json.NewEncoder(w).Encode(pm.Config)
		return
	}

	if r.Method == http.MethodPost {
		if r.URL.Query().Get("action") == "reset" {
			_ = os.Remove("m3u/config.json")
			pm.LoadConfig()
			_, _ = w.Write([]byte(`{"status":"ok","message":"配置已重置"}`))
			return
		}

		var newCfg manager.FFmpegConfig
		if err := json.NewDecoder(r.Body).Decode(&newCfg); err != nil {
			http.Error(w, "无效的配置数据", http.StatusBadRequest)
			return
		}

		pm.Config = newCfg
		pm.SaveConfig()
		_, _ = w.Write([]byte(`{"status":"ok","message":"配置保存成功"}`))
		return
	}

	http.Error(w, "不支持的请求方法", http.StatusMethodNotAllowed)
}

func uploadHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST 请求", http.StatusMethodNotAllowed)
		return
	}

	file, _, err := r.FormFile("m3uFile")
	if err != nil {
		http.Error(w, "文件上传失败", http.StatusBadRequest)
		return
	}
	defer file.Close()

	tmpPath := filepath.Join("m3u", "source.m3u")
	out, err := os.Create(tmpPath)
	if err != nil {
		http.Error(w, "创建临时文件失败", http.StatusInternalServerError)
		return
	}

	written, err := io.Copy(out, io.LimitReader(file, maxM3UBytes+1))
	if err != nil {
		_ = out.Close()
		http.Error(w, "写入临时文件失败", http.StatusInternalServerError)
		return
	}
	_ = out.Close()
	if written > maxM3UBytes {
		http.Error(w, "文件过大", http.StatusRequestEntityTooLarge)
		return
	}

	parseAndRespond(w, r, tmpPath)
}

func uploadURLHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST 请求", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "请求体格式错误", http.StatusBadRequest)
		return
	}
	req.URL = strings.TrimSpace(req.URL)
	if req.URL == "" {
		http.Error(w, "订阅链接不能为空", http.StatusBadRequest)
		return
	}

	parsedURL, err := url.ParseRequestURI(req.URL)
	if err != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		http.Error(w, "仅支持 http/https 协议链接", http.StatusBadRequest)
		return
	}

	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Get(req.URL)
	if err != nil {
		http.Error(w, "拉取订阅失败", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		http.Error(w, fmt.Sprintf("拉取订阅失败，HTTP %d", resp.StatusCode), http.StatusBadGateway)
		return
	}

	tmpPath := filepath.Join("m3u", "source.m3u")
	out, err := os.Create(tmpPath)
	if err != nil {
		http.Error(w, "创建临时文件失败", http.StatusInternalServerError)
		return
	}

	written, err := io.Copy(out, io.LimitReader(resp.Body, maxM3UBytes+1))
	if err != nil {
		_ = out.Close()
		http.Error(w, "保存订阅文件失败", http.StatusInternalServerError)
		return
	}
	_ = out.Close()

	if written > maxM3UBytes {
		http.Error(w, "订阅文件过大", http.StatusRequestEntityTooLarge)
		return
	}

	parseAndRespond(w, r, tmpPath)
}

func parseAndRespond(w http.ResponseWriter, r *http.Request, sourcePath string) {
	addr := "http://" + r.Host
	channels, err := parser.ParseAndGenerate(sourcePath, addr)
	if err != nil {
		http.Error(w, "解析失败", http.StatusInternalServerError)
		return
	}
	_, _ = fmt.Fprintf(w, `{"status":"ok","count":%d,"message":"解析完成"}`, len(channels))
}

func clearDataHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST 请求", http.StatusMethodNotAllowed)
		return
	}

	pm.ClearAll(TempDir)

	_ = os.Remove(filepath.Join("m3u", "source.m3u"))
	_ = os.Remove(filepath.Join("m3u", "mapping.json"))
	_ = os.Remove(filepath.Join("m3u", PlaylistName))

	logosPath := filepath.Join("m3u", "logos")
	_ = os.RemoveAll(logosPath)
	_ = os.MkdirAll(logosPath, 0755)

	_, _ = w.Write([]byte(`{"status":"ok","message":"已清除导入数据"}`))
}

func listHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")

	data, err := os.ReadFile("m3u/mapping.json")
	if err != nil {
		_, _ = w.Write([]byte("[]"))
		return
	}
	_, _ = w.Write(data)
}

func playlistHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/mpegurl")
	http.ServeFile(w, r, filepath.Join("m3u", PlaylistName))
}

func streamHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")

	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 3 {
		http.NotFound(w, r)
		return
	}

	id, file := parts[1], parts[2]
	pm.KeepAlive(id)

	if strings.HasSuffix(file, ".m3u8") {
		content, err := pm.GetM3u8Content(id, TempDir)
		if err != nil {
			http.Error(w, "流启动失败: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		_, _ = w.Write(content)
		return
	}

	tsPath := filepath.Join(TempDir, id, file)
	http.ServeFile(w, r, tsPath)
}

func statusHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")

	cpuUsage, memUsage := getSystemStats()
	data := struct {
		ActiveCount int      `json:"active_count"`
		RunningIDs  []string `json:"running_ids"`
		CPU         string   `json:"cpu"`
		Mem         string   `json:"mem"`
	}{
		ActiveCount: pm.GetActiveCount(),
		RunningIDs:  pm.GetProcesses(),
		CPU:         cpuUsage,
		Mem:         memUsage,
	}

	_ = json.NewEncoder(w).Encode(data)
}

