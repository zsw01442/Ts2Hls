package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"TsToHls/manager"
	"TsToHls/parser"

	"github.com/gin-gonic/gin"
)

const (
	Port         = "15140"      // 服务监听端口
	HLSOutputDir = "./data/hls" // HLS输出目录
	M3UInputDir  = "./data/m3u" // 上传的M3U文件目录
)

// 全局变量
var (
	pm               *manager.ProcessManager // FFmpeg进程管理器
	channelList      []parser.Channel        // 解析后的频道列表
	originalFileName string                  // 原始上传文件名
)

func main() {
	// 初始化
	pm = manager.NewProcessManager()
	cleanOutputDirs()

	// 清理并重建m3u目录（上传即覆盖）
	os.RemoveAll(M3UInputDir)
	os.MkdirAll(M3UInputDir, 0755)

	// 加载现有的M3U文件
	if err := loadExistingM3U(); err != nil {
		fmt.Printf("加载现有M3U文件失败: %v\n", err)
	}

	// 创建Gin引擎
	r := gin.Default()

	// 静态文件路由
	r.Static("/web", "./web")       // 前端页面
	r.Static("/live", HLSOutputDir) // HLS切片文件

	// API路由
	api := r.Group("/api")
	{
		api.POST("/upload", handleUpload)               // 上传M3U文件
		api.GET("/status", handleStatus)                // 获取服务状态
		api.GET("/current-status", handleCurrentStatus) // 获取当前状态
		api.GET("/download/:filename", handleDownload)  // 下载M3U文件
	}

	// 代理路由
	r.GET("/stream/:id/index.m3u8", handleStreamRequest)

	// 启动服务
	fmt.Printf("服务启动，监听端口 %s\n", Port)
	r.Run(":" + Port)
}

// loadExistingM3U 加载现有的M3U文件
func loadExistingM3U() error {
	files, err := os.ReadDir(M3UInputDir)
	if err != nil {
		return err
	}

	for _, file := range files {
		if strings.HasSuffix(file.Name(), ".m3u") || strings.HasSuffix(file.Name(), ".m3u8") {
			m3uPath := filepath.Join(M3UInputDir, file.Name())
			channels, _, err := parser.ParseAndRewrite(m3uPath, "localhost:"+Port)
			if err != nil {
				fmt.Printf("解析现有M3U文件 %s 失败: %v\n", file.Name(), err)
				continue
			}
			// 直接更新channelList，不再使用append
			channelList = channels
			break // 只加载第一个文件
		}
	}
	return nil
}

// cleanOutputDirs 清理输出目录
func cleanOutputDirs() {
	os.RemoveAll(HLSOutputDir)
	os.MkdirAll(HLSOutputDir, 0755)
	os.MkdirAll(M3UInputDir, 0755)
}

// handleDownload 处理M3U文件下载
func handleDownload(c *gin.Context) {
	filename := c.Param("filename")
	filePath := filepath.Join(M3UInputDir, filename)

	// 安全检查：防止目录遍历
	if !strings.HasPrefix(filePath, M3UInputDir) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的文件路径"})
		return
	}

	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "文件不存在"})
		return
	}

	c.File(filePath)
}

// handleUpload 处理M3U文件上传
func handleUpload(c *gin.Context) {
	file, err := c.FormFile("m3uFile")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的上传文件"})
		return
	}

	// 清理m3u目录并重建
	os.RemoveAll(M3UInputDir)
	os.MkdirAll(M3UInputDir, 0755)

	// 保存上传的文件
	m3uPath := filepath.Join(M3UInputDir, file.Filename)
	if err := c.SaveUploadedFile(file, m3uPath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "文件保存失败"})
		return
	}

	// 记录原始文件名
	originalFileName = file.Filename

	// 解析并重写M3U文件
	channels, newM3UContent, err := parser.ParseAndRewrite(m3uPath, c.Request.Host)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "解析M3U文件失败: " + err.Error()})
		return
	}

	// 更新全局频道列表
	channelList = channels

	// 保存转换后的M3U文件
	outputFilename := "converted_" + file.Filename
	outputPath := filepath.Join(M3UInputDir, outputFilename)
	if err := os.WriteFile(outputPath, []byte(newM3UContent), 0644); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "无法保存转换后的M3U文件"})
		return
	}

	// 返回结果
	c.JSON(http.StatusOK, gin.H{
		"channels":         channels,
		"m3u":              newM3UContent,
		"m3uUrl":           fmt.Sprintf("http://%s/api/download/%s", c.Request.Host, outputFilename),
		"originalFileName": file.Filename,
	})
}

// handleStreamRequest 处理流请求
// 访问格式: /stream/[channelID]/index.m3u8
func handleStreamRequest(c *gin.Context) {
	id := c.Param("id")
	channel := parser.GetChannelByID(channelList, id)
	if channel == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "频道不存在"})
		return
	}

	// 准备输出目录
	outputDir := filepath.Join(HLSOutputDir, id)
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "创建输出目录失败"})
		return
	}

	// 启动FFmpeg转码进程
	if err := pm.StartProcess(id, channel.OriginalURL, outputDir); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "启动转码进程失败: " + err.Error()})
		return
	}

	// 等待HLS文件生成（最多10秒）
	m3u8Path := filepath.Join(outputDir, "index.m3u8")
	for i := 0; i < 20; i++ {
		if _, err := os.Stat(m3u8Path); err == nil {
			// 文件已生成，重定向到静态文件
			c.Redirect(http.StatusFound, "/live/"+id+"/index.m3u8")
			return
		}
		time.Sleep(500 * time.Millisecond)
	}

	c.JSON(http.StatusInternalServerError, gin.H{"error": "HLS文件生成超时"})
}

// handleStatus 返回当前系统状态
func handleStatus(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"active_processes": pm.GetActiveCount(),
		"channel_count":    len(channelList),
		"status":           "success",
		"filename":         originalFileName,
		"channels":         channelList,
	})
}

// handleCurrentStatus 获取当前状态
func handleCurrentStatus(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"channelsEmpty":    len(channelList) == 0,
		"currentFile":      originalFileName,
		"originalFileName": originalFileName,
		"channelCount":     len(channelList),
		"active_processes": pm.GetActiveCount(),
	})
}
