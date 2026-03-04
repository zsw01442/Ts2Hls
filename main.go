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
	"sort"
	"strings"
	"sync"
	"time"

	"ts2hls/manager"
	"ts2hls/parser"

	pinyin "github.com/mozillazg/go-pinyin"
	"github.com/shirou/gopsutil/v3/cpu"
)

const (
	Port             = "15140"
	TempDir          = "hls_temp"
	AppName          = "Ts2Hls"
	AppVersion       = "1.4.0"
	PlaylistName     = "ts2hls.m3u"
	SourceProfiles   = "m3u/sources.json"
	DefaultSourceKey = "source1"
	MaxSourceNameLen = 24
	maxM3UBytes      = 20 * 1024 * 1024
)

type SourceProfile struct {
	Key  string `json:"key"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

var (
	pmBySource map[string]*manager.ProcessManager
	sourceList []SourceProfile
	sourceMu   sync.RWMutex
)

func main() {
	if err := initSourcesAndManagers(); err != nil {
		log.Fatalf("初始化失败: %v", err)
	}

	staticFS := http.FileServer(http.Dir(filepath.Join("web", "static")))
	http.Handle("/static/", http.StripPrefix("/static/", staticFS))

	// /logos/source1/logos/ch001.png -> m3u/source1/logos/ch001.png
	logoFS := http.FileServer(http.Dir("m3u"))
	http.Handle("/logos/", http.StripPrefix("/logos/", logoFS))

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.ServeFile(w, r, filepath.Join("web", "index.html"))
			return
		}
		http.NotFound(w, r)
	})

	http.HandleFunc("/api/sources", sourcesHandler)
	http.HandleFunc("/api/sources/rename", renameSourceHandler)
	http.HandleFunc("/api/upload", uploadHandler)
	http.HandleFunc("/api/upload/url", uploadURLHandler)
	http.HandleFunc("/api/data/clear", clearDataHandler)
	http.HandleFunc("/api/list", listHandler)
	http.HandleFunc("/api/status", statusHandler)
	http.HandleFunc("/api/config", configHandler)

	http.HandleFunc("/playlist/", playlistHandler)
	http.HandleFunc("/stream/", streamHandler)

	fmt.Println("-------------------------------------------")
	fmt.Printf("%s v%s 服务已启动\n", AppName, AppVersion)
	fmt.Printf("管理界面: http://127.0.0.1:%s\n", Port)
	for _, src := range snapshotSources() {
		fmt.Printf("%s 订阅: http://127.0.0.1:%s%s\n", src.Name, Port, sourcePlaylistPath(src.Slug))
	}
	fmt.Println("-------------------------------------------")

	log.Fatal(http.ListenAndServe(":"+Port, nil))
}

func defaultSources() []SourceProfile {
	return []SourceProfile{
		{Key: "source1", Name: "直播源一"},
		{Key: "source2", Name: "直播源二"},
		{Key: "source3", Name: "直播源三"},
	}
}

func sourceM3uDir(sourceKey string) string {
	return filepath.Join("m3u", sourceKey)
}

func sourceTempDir(sourceKey string) string {
	return filepath.Join(TempDir, sourceKey)
}

func sourceLogosDir(sourceKey string) string {
	return filepath.Join(sourceM3uDir(sourceKey), "logos")
}

func sourceFile(sourceKey, name string) string {
	return filepath.Join(sourceM3uDir(sourceKey), name)
}

func sourceConfigPath(sourceKey string) string {
	return sourceFile(sourceKey, "config.json")
}

func sourceMappingPath(sourceKey string) string {
	return sourceFile(sourceKey, "mapping.json")
}

func sourcePlaylistPath(slug string) string {
	return "/playlist/" + slug + ".m3u"
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return !info.IsDir()
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return info.IsDir()
}

func copyFileIfMissing(src, dst string) {
	if !fileExists(src) || fileExists(dst) {
		return
	}

	data, err := os.ReadFile(src)
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(dst), 0755)
	_ = os.WriteFile(dst, data, 0644)
}

func copyDirContentsIfTargetEmpty(src, dst string) {
	if !dirExists(src) || !dirExists(dst) {
		return
	}
	dstEntries, err := os.ReadDir(dst)
	if err != nil || len(dstEntries) > 0 {
		return
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		copyFileIfMissing(filepath.Join(src, entry.Name()), filepath.Join(dst, entry.Name()))
	}
}

func migrateLegacyDataToSource1() {
	sourceKey := DefaultSourceKey
	copyFileIfMissing(filepath.Join("m3u", "source.m3u"), sourceFile(sourceKey, "source.m3u"))
	copyFileIfMissing(filepath.Join("m3u", "config.json"), sourceFile(sourceKey, "config.json"))

	legacyMapping := filepath.Join("m3u", "mapping.json")
	targetMapping := sourceFile(sourceKey, "mapping.json")
	if fileExists(legacyMapping) && !fileExists(targetMapping) {
		data, err := os.ReadFile(legacyMapping)
		if err == nil {
			var channels []parser.Channel
			if err := json.Unmarshal(data, &channels); err == nil {
				for i := range channels {
					logo := channels[i].Logo
					if strings.HasPrefix(logo, "/logos/") && !strings.HasPrefix(logo, "/logos/"+sourceKey+"/") {
						logoFile := strings.TrimPrefix(logo, "/logos/")
						channels[i].Logo = "/logos/" + sourceKey + "/logos/" + logoFile
					}
				}
				if out, mErr := json.MarshalIndent(channels, "", "  "); mErr == nil {
					_ = os.WriteFile(targetMapping, out, 0644)
				}
			} else {
				_ = os.WriteFile(targetMapping, data, 0644)
			}
		}
	}

	legacyPlaylist := filepath.Join("m3u", PlaylistName)
	targetPlaylist := sourceFile(sourceKey, PlaylistName)
	if fileExists(legacyPlaylist) && !fileExists(targetPlaylist) {
		data, err := os.ReadFile(legacyPlaylist)
		if err == nil {
			content := strings.ReplaceAll(string(data), "/stream/", "/stream/"+sourceKey+"/")
			_ = os.WriteFile(targetPlaylist, []byte(content), 0644)
		}
	}

	copyDirContentsIfTargetEmpty(filepath.Join("m3u", "logos"), sourceLogosDir(sourceKey))
}

func toPinyinSlug(name, fallback string) string {
	clean := strings.TrimSpace(name)
	if clean == "" {
		return fallback
	}

	args := pinyin.NewArgs()
	args.Separator = ""
	parts := pinyin.Pinyin(clean, args)
	var b strings.Builder
	for _, row := range parts {
		if len(row) == 0 {
			continue
		}
		b.WriteString(row[0])
	}

	slug := strings.ToLower(b.String())
	if slug == "" {
		slug = strings.ToLower(clean)
	}

	var out strings.Builder
	prevDash := false
	for _, r := range slug {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			out.WriteRune(r)
			prevDash = false
		default:
			if !prevDash {
				out.WriteRune('-')
				prevDash = true
			}
		}
	}

	final := strings.Trim(out.String(), "-")
	if final == "" {
		final = fallback
	}
	if len(final) > 32 {
		final = strings.Trim(final[:32], "-")
	}
	if final == "" {
		final = fallback
	}
	return final
}

func normalizeSources(items []SourceProfile) []SourceProfile {
	base := defaultSources()
	index := make(map[string]SourceProfile, len(items))
	for _, item := range items {
		k := strings.TrimSpace(item.Key)
		if k == "" {
			continue
		}
		index[k] = item
	}

	out := make([]SourceProfile, 0, len(base))
	for _, def := range base {
		existing, ok := index[def.Key]
		current := def
		if ok {
			if name := strings.TrimSpace(existing.Name); name != "" {
				current.Name = name
			}
			current.Slug = strings.TrimSpace(existing.Slug)
		}
		if current.Slug == "" {
			current.Slug = toPinyinSlug(current.Name, current.Key)
		}
		out = append(out, current)
	}

	ensureUniqueSlugs(out)
	return out
}

func ensureUniqueSlugs(items []SourceProfile) {
	used := map[string]int{}
	for i := range items {
		base := strings.TrimSpace(items[i].Slug)
		if base == "" {
			base = toPinyinSlug(items[i].Name, items[i].Key)
		}
		seq := 1
		slug := base
		for {
			if _, ok := used[slug]; !ok {
				break
			}
			seq++
			slug = fmt.Sprintf("%s-%d", base, seq)
		}
		used[slug] = 1
		items[i].Slug = slug
	}
}

func saveSources(items []SourceProfile) error {
	data, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(SourceProfiles, data, 0644)
}

func initSourcesAndManagers() error {
	_ = os.MkdirAll("m3u", 0755)
	_ = os.MkdirAll(TempDir, 0755)

	raw, err := os.ReadFile(SourceProfiles)
	if err != nil {
		sourceList = normalizeSources(nil)
		if saveErr := saveSources(sourceList); saveErr != nil {
			return saveErr
		}
	} else {
		var loaded []SourceProfile
		if uErr := json.Unmarshal(raw, &loaded); uErr != nil {
			sourceList = normalizeSources(nil)
		} else {
			sourceList = normalizeSources(loaded)
		}
		if saveErr := saveSources(sourceList); saveErr != nil {
			return saveErr
		}
	}

	pmBySource = make(map[string]*manager.ProcessManager, len(sourceList))
	for _, source := range sourceList {
		_ = os.MkdirAll(sourceM3uDir(source.Key), 0755)
		_ = os.MkdirAll(sourceLogosDir(source.Key), 0755)
		_ = os.MkdirAll(sourceTempDir(source.Key), 0755)

		pmBySource[source.Key] = manager.NewProcessManager(
			sourceMappingPath(source.Key),
			sourceConfigPath(source.Key),
		)
	}

	// 兼容旧版单直播源目录，自动迁移到 source1。
	migrateLegacyDataToSource1()

	return nil
}

func snapshotSources() []SourceProfile {
	sourceMu.RLock()
	defer sourceMu.RUnlock()

	out := make([]SourceProfile, len(sourceList))
	copy(out, sourceList)
	sort.Slice(out, func(i, j int) bool {
		return out[i].Key < out[j].Key
	})
	return out
}

func defaultSourceKey() string {
	sourceMu.RLock()
	defer sourceMu.RUnlock()
	if len(sourceList) == 0 {
		return DefaultSourceKey
	}
	return sourceList[0].Key
}

func findSourceByKey(key string) (SourceProfile, bool) {
	sourceMu.RLock()
	defer sourceMu.RUnlock()
	for _, src := range sourceList {
		if src.Key == key {
			return src, true
		}
	}
	return SourceProfile{}, false
}

func findSourceBySlug(slug string) (SourceProfile, bool) {
	sourceMu.RLock()
	defer sourceMu.RUnlock()
	for _, src := range sourceList {
		if src.Slug == slug {
			return src, true
		}
	}
	return SourceProfile{}, false
}

func resolveSourceKey(r *http.Request) string {
	key := strings.TrimSpace(r.URL.Query().Get("source"))
	if key == "" {
		return defaultSourceKey()
	}
	if _, ok := findSourceByKey(key); ok {
		return key
	}
	return defaultSourceKey()
}

func sourceManager(key string) *manager.ProcessManager {
	if pm, ok := pmBySource[key]; ok {
		return pm
	}
	return nil
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

func sourcesHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		http.Error(w, "仅支持 GET 请求", http.StatusMethodNotAllowed)
		return
	}

	_ = json.NewEncoder(w).Encode(struct {
		Sources []SourceProfile `json:"sources"`
	}{
		Sources: snapshotSources(),
	})
}

func renameSourceHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST 请求", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Key  string `json:"key"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "请求体格式错误", http.StatusBadRequest)
		return
	}

	req.Key = strings.TrimSpace(req.Key)
	req.Name = strings.TrimSpace(req.Name)
	if req.Key == "" || req.Name == "" {
		http.Error(w, "参数不能为空", http.StatusBadRequest)
		return
	}
	if len([]rune(req.Name)) > MaxSourceNameLen {
		http.Error(w, "名称过长", http.StatusBadRequest)
		return
	}

	var updated SourceProfile
	sourceMu.Lock()
	found := false
	for i := range sourceList {
		if sourceList[i].Key == req.Key {
			sourceList[i].Name = req.Name
			sourceList[i].Slug = toPinyinSlug(req.Name, sourceList[i].Key)
			found = true
			break
		}
	}
	if !found {
		sourceMu.Unlock()
		http.Error(w, "直播源不存在", http.StatusBadRequest)
		return
	}

	ensureUniqueSlugs(sourceList)
	for _, src := range sourceList {
		if src.Key == req.Key {
			updated = src
			break
		}
	}
	snapshot := make([]SourceProfile, len(sourceList))
	copy(snapshot, sourceList)
	sourceMu.Unlock()

	if err := saveSources(snapshot); err != nil {
		http.Error(w, "保存直播源信息失败", http.StatusInternalServerError)
		return
	}

	_ = json.NewEncoder(w).Encode(struct {
		Status   string        `json:"status"`
		Source   SourceProfile `json:"source"`
		Playlist string        `json:"playlist"`
	}{
		Status:   "ok",
		Source:   updated,
		Playlist: sourcePlaylistPath(updated.Slug),
	})
}

func configHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")

	sourceKey := resolveSourceKey(r)
	pm := sourceManager(sourceKey)
	if pm == nil {
		http.Error(w, "无效的直播源", http.StatusBadRequest)
		return
	}

	if r.Method == http.MethodGet {
		_ = json.NewEncoder(w).Encode(pm.Config)
		return
	}

	if r.Method == http.MethodPost {
		if r.URL.Query().Get("action") == "reset" {
			_ = os.Remove(sourceConfigPath(sourceKey))
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

	sourceKey := resolveSourceKey(r)

	file, _, err := r.FormFile("m3uFile")
	if err != nil {
		http.Error(w, "文件上传失败", http.StatusBadRequest)
		return
	}
	defer file.Close()

	tmpPath := sourceFile(sourceKey, "source.m3u")
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

	parseAndRespond(w, r, tmpPath, sourceKey)
}

func uploadURLHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST 请求", http.StatusMethodNotAllowed)
		return
	}

	sourceKey := resolveSourceKey(r)

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

	tmpPath := sourceFile(sourceKey, "source.m3u")
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

	parseAndRespond(w, r, tmpPath, sourceKey)
}

func parseAndRespond(w http.ResponseWriter, r *http.Request, sourcePath, sourceKey string) {
	addr := "http://" + r.Host
	channels, err := parser.ParseAndGenerate(
		sourcePath,
		sourceM3uDir(sourceKey),
		addr,
		"/stream/"+sourceKey,
		"/logos/"+sourceKey+"/logos",
	)
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

	sourceKey := resolveSourceKey(r)
	pm := sourceManager(sourceKey)
	if pm == nil {
		http.Error(w, "无效的直播源", http.StatusBadRequest)
		return
	}

	pm.ClearAll(sourceTempDir(sourceKey))

	_ = os.Remove(sourceFile(sourceKey, "source.m3u"))
	_ = os.Remove(sourceFile(sourceKey, "mapping.json"))
	_ = os.Remove(sourceFile(sourceKey, PlaylistName))

	logosPath := sourceLogosDir(sourceKey)
	_ = os.RemoveAll(logosPath)
	_ = os.MkdirAll(logosPath, 0755)

	_, _ = w.Write([]byte(`{"status":"ok","message":"已清除导入数据"}`))
}

func listHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")

	sourceKey := resolveSourceKey(r)
	data, err := os.ReadFile(sourceMappingPath(sourceKey))
	if err != nil {
		_, _ = w.Write([]byte("[]"))
		return
	}
	_, _ = w.Write(data)
}

func playlistHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/mpegurl")

	path := strings.TrimPrefix(r.URL.Path, "/playlist/")
	path = strings.TrimSpace(path)
	if path == "" {
		http.NotFound(w, r)
		return
	}

	var sourceKey string
	if path == PlaylistName {
		sourceKey = defaultSourceKey() // 兼容旧地址 /playlist/ts2hls.m3u
	} else if strings.HasSuffix(path, "/"+PlaylistName) {
		key := strings.TrimSuffix(path, "/"+PlaylistName)
		if _, ok := findSourceByKey(key); ok {
			sourceKey = key
		}
	} else if strings.HasSuffix(path, ".m3u") {
		slug := strings.TrimSuffix(path, ".m3u")
		if src, ok := findSourceBySlug(slug); ok {
			sourceKey = src.Key
		}
	}

	if sourceKey == "" {
		http.NotFound(w, r)
		return
	}

	http.ServeFile(w, r, sourceFile(sourceKey, PlaylistName))
}

func streamHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")

	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	// /stream/{source}/{channel}/index.m3u8
	if len(parts) < 4 {
		http.NotFound(w, r)
		return
	}

	sourceKey, id := parts[1], parts[2]
	if _, ok := findSourceByKey(sourceKey); !ok {
		http.NotFound(w, r)
		return
	}

	pm := sourceManager(sourceKey)
	if pm == nil {
		http.NotFound(w, r)
		return
	}

	file := strings.Join(parts[3:], "/")
	pm.KeepAlive(id)

	if strings.HasSuffix(file, ".m3u8") {
		content, err := pm.GetM3u8Content(id, sourceTempDir(sourceKey))
		if err != nil {
			http.Error(w, "流启动失败: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		_, _ = w.Write(content)
		return
	}

	tsPath := filepath.Join(sourceTempDir(sourceKey), id, file)
	http.ServeFile(w, r, tsPath)
}

func statusHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")

	sourceKey := resolveSourceKey(r)
	pm := sourceManager(sourceKey)
	if pm == nil {
		http.Error(w, "无效的直播源", http.StatusBadRequest)
		return
	}

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
