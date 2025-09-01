const fs = require('fs');
const path = require('path');
const https = require('https');
const { parse } = require('node-html-parser');

class TikTokDownloader {
    constructor(url) {
        this.url = url;
        this.videoId = this.getVideoId();
        this.cookies = '';
    }

    getVideoId() {
        const parts = this.url.split('/');
        return parts[parts.length - 1];
    }

    async getDownloadAddr() {
        try {
            // Fetch the TikTok page with proper headers
            const html = await this.fetchPage(this.url);
            
            // Parse the HTML
            const root = parse(html);
            
            // Try to find the video data in different possible locations
            const scriptTag = root.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
            
            if (!scriptTag) {
                throw new Error('Could not find video data on page');
            }
            
            // Parse the JSON data
            const parsedJson = JSON.parse(scriptTag.text);
            
            // Try different paths to extract video URL
            let videoData;
            
            // First try the standard path
            if (parsedJson['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.itemInfo?.itemStruct) {
                videoData = parsedJson['__DEFAULT_SCOPE__']['webapp.video-detail'].itemInfo.itemStruct;
            } 
            // Try alternative paths that might contain non-watermarked versions
            else if (parsedJson['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.itemInfo?.itemStruct) {
                videoData = parsedJson['__DEFAULT_SCOPE__']['webapp.video-detail'].itemInfo.itemStruct;
            } else {
                // Search through all keys for video data
                const keys = Object.keys(parsedJson);
                for (const key of keys) {
                    if (parsedJson[key]?.itemInfo?.itemStruct) {
                        videoData = parsedJson[key].itemInfo.itemStruct;
                        break;
                    }
                }
            }
            
            if (!videoData) {
                throw new Error('Video data not found in JSON');
            }
            
            // Try to find the best video URL without breaking it
            const results = await this.findBestVideoUrl(videoData);
            
            return results;
            
        } catch (error) {
            console.error('Error getting download address:', error.message);
            return null;
        }
    }

    async findBestVideoUrl(videoData) {
        const videoSources = [];
        
        // Collect all possible video URLs
        if (videoData.video) {
            // Priority 1: downloadAddr (usually no watermark, but rare)
            if (videoData.video.downloadAddr) {
                videoSources.push({
                    url: videoData.video.downloadAddr,
                    type: 'downloadAddr',
                    priority: 1
                });
            }
            
            // Priority 2: playAddrH264 (high quality)
            if (videoData.video.playAddrH264) {
                videoSources.push({
                    url: videoData.video.playAddrH264,
                    type: 'playAddrH264', 
                    priority: 2
                });
            }
            
            // Priority 3: Your original working method
            if (videoData.video.playAddr) {
                videoSources.push({
                    url: videoData.video.playAddr,
                    type: 'playAddr',
                    priority: 3
                });
            }
            
            // Priority 4: bitrateInfo (alternative sources)
            if (videoData.video.bitrateInfo && Array.isArray(videoData.video.bitrateInfo)) {
                videoData.video.bitrateInfo.forEach((bitrate, index) => {
                    if (bitrate.PlayAddr && bitrate.PlayAddr.UrlList) {
                        bitrate.PlayAddr.UrlList.forEach((url, urlIndex) => {
                            videoSources.push({
                                url: url,
                                type: `bitrateInfo[${index}][${urlIndex}]`,
                                priority: 4 + index,
                                quality: bitrate.QualityType
                            });
                        });
                    }
                });
            }
        }
        
        if (videoSources.length === 0) {
            throw new Error('No video sources found');
        }
        
        // Sort by priority
        videoSources.sort((a, b) => a.priority - b.priority);
        
        console.log(`Found ${videoSources.length} video sources:`);
        videoSources.forEach(source => {
            console.log(`  - ${source.type} (priority ${source.priority})`);
        });
        
        // Test each URL and return the first working one
        for (const source of videoSources) {
            console.log(`\nTesting ${source.type}...`);
            
            // Clean up basic escape characters only (don't modify parameters yet)
            const basicCleanUrl = source.url.replace(/\\u0026/g, '&');
            
            const isAccessible = await this.testVideoUrl(basicCleanUrl);
            
            if (isAccessible) {
                console.log(`✓ ${source.type} is accessible`);
                
                // Now try to download with both original and modified versions
                return {
                    originalUrl: basicCleanUrl,
                    type: source.type,
                    priority: source.priority
                };
            } else {
                console.log(`✗ ${source.type} is not accessible`);
            }
        }
        
        // If no URLs are accessible, return the original working method as fallback
        const fallback = videoSources.find(s => s.type === 'playAddr');
        if (fallback) {
            console.log('\nUsing fallback playAddr...');
            return {
                originalUrl: fallback.url.replace(/\\u0026/g, '&'),
                type: 'playAddr (fallback)',
                priority: fallback.priority
            };
        }
        
        throw new Error('No accessible video URLs found');
    }

    async testVideoUrl(url) {
        return new Promise((resolve) => {
            const options = {
                method: 'HEAD',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.80 Safari/537.36',
                    'Referer': 'https://www.tiktok.com/',
                    'Cookie': this.cookies,
                    'Accept': '*/*',
                    'Range': 'bytes=0-1'
                }
            };

            const request = https.request(url, options, (res) => {
                const isWorking = (res.statusCode >= 200 && res.statusCode < 300) || 
                                (res.statusCode >= 300 && res.statusCode < 400);
                resolve(isWorking);
            });
            
            request.on('error', (err) => {
                console.log(`    Error testing URL: ${err.message}`);
                resolve(false);
            });
            
            request.setTimeout(3000, () => {
                request.destroy();
                resolve(false);
            });
            
            request.end();
        });
    }

    async tryMultipleDownloads(videoInfo, filename) {
        const attempts = [
            // Attempt 1: Original URL (your working method)
            {
                url: videoInfo.originalUrl,
                name: 'Original',
                suffix: '_original'
            },
            
            // Attempt 2: Try simple watermark parameter modifications
            {
                url: videoInfo.originalUrl.replace(/watermark=1/g, 'watermark=0'),
                name: 'Watermark Modified',
                suffix: '_no_watermark'
            }
        ];
        
        // Only try parameter modifications if URL contains watermark parameters
        if (videoInfo.originalUrl.includes('watermark=1')) {
            attempts.push({
                url: videoInfo.originalUrl
                    .replace(/watermark=1/g, 'watermark=0')
                    .replace(/logo=1/g, 'logo=0'),
                name: 'Full Parameter Modified',
                suffix: '_full_modified'
            });
        }
        
        const results = [];
        
        for (const attempt of attempts) {
            try {
                console.log(`\nAttempting download: ${attempt.name}`);
                console.log(`URL: ${attempt.url.substring(0, 100)}...`);
                
                const baseFilename = filename.replace('.mp4', '');
                const attemptFilename = `${baseFilename}${attempt.suffix}.mp4`;
                
                const filePath = await this.downloadVideo(attempt.url, attemptFilename);
                
                // Check if file is valid
                const stats = fs.statSync(filePath);
                if (stats.size > 1024) { // File is larger than 1KB
                    console.log(`✓ ${attempt.name} download successful: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
                    results.push({
                        type: attempt.name,
                        path: filePath,
                        size: stats.size,
                        url: attempt.url
                    });
                } else {
                    console.log(`✗ ${attempt.name} download failed: file too small`);
                    fs.unlinkSync(filePath); // Delete small/corrupted file
                }
                
            } catch (error) {
                console.log(`✗ ${attempt.name} download failed: ${error.message}`);
            }
        }
        
        return results;
    }

    fetchPage(url) {
        return new Promise((resolve, reject) => {
            const options = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.80 Safari/537.36',
                    'Referer': 'https://www.tiktok.com/',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Connection': 'keep-alive',
                    'Cookie': 'tt_webid_v2=689854141086886123; tt_webid_v2=BOB'
                }
            };

            https.get(url, options, (res) => {
                if (res.headers['set-cookie']) {
                    this.cookies = res.headers['set-cookie'].join('; ');
                }
                
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        this.fetchPage(res.headers.location).then(resolve).catch(reject);
                    } else if (res.statusCode === 200) {
                        resolve(data);
                    } else {
                        reject(new Error(`Request failed with status code ${res.statusCode}`));
                    }
                });
            }).on('error', (err) => {
                reject(err);
            });
        });
    }

    downloadVideo(videoUrl, filename) {
        return new Promise((resolve, reject) => {
            const dir = './videos';
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const filePath = path.join(dir, filename);
            const file = fs.createWriteStream(filePath);
            
            const options = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.80 Safari/537.36',
                    'Referer': 'https://www.tiktok.com/',
                    'Cookie': this.cookies,
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Connection': 'keep-alive',
                }
            };

            https.get(videoUrl, options, (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    this.downloadVideo(response.headers.location, filename)
                        .then(resolve)
                        .catch(reject);
                    return;
                }
                
                if (response.statusCode !== 200) {
                    reject(new Error(`Video download failed with status code ${response.statusCode}`));
                    return;
                }
                
                const contentLength = parseInt(response.headers['content-length'], 10);
                let downloadedLength = 0;
                
                response.on('data', (chunk) => {
                    downloadedLength += chunk.length;
                    if (contentLength) {
                        const percent = (downloadedLength / contentLength * 100).toFixed(2);
                        process.stdout.write(`    Progress: ${percent}%\r`);
                    }
                });
                
                response.pipe(file);
                
                file.on('finish', () => {
                    file.close();
                    resolve(filePath);
                });
            }).on('error', (err) => {
                fs.unlink(filePath, () => {});
                reject(err);
            });
        });
    }

    async run() {
        try {
            console.log('Getting download addresses...');
            const videoInfo = await this.getDownloadAddr();
            
            if (!videoInfo) {
                throw new Error('Failed to get video URLs');
            }
            
            console.log(`\nUsing ${videoInfo.type} as best source`);
            console.log('Starting multiple download attempts...');
            
            const filename = `${this.videoId}.mp4`;
            const results = await this.tryMultipleDownloads(videoInfo, filename);
            
            if (results.length === 0) {
                throw new Error('All download attempts failed');
            }
            
            console.log(`\n=== DOWNLOAD RESULTS ===`);
            results.forEach((result, index) => {
                console.log(`${index + 1}. ${result.type}`);
                console.log(`   File: ${result.path}`);
                console.log(`   Size: ${(result.size / 1024 / 1024).toFixed(2)} MB`);
                console.log(`   URL type: ${videoInfo.type}`);
            });
            
            console.log(`\n✓ Successfully downloaded ${results.length} version(s)`);
            console.log(`Check the files to see which one has the best quality/watermark status`);
            
            return this.videoId;
        } catch (error) {
            console.error('Error in TikTok downloader:', error.message);
            return null;
        }
    }
}

// Test with the provided URL
const testUrl = "https://www.tiktok.com/@hackphonex/video/7535517022529047830";
const downloader = new TikTokDownloader(testUrl);

downloader.run()
    .then(videoId => {
        if (videoId) {
            console.log(`\nProcess completed for video ${videoId}`);
        } else {
            console.log('Download process failed.');
        }
    })
    .catch(err => {
        console.error('Unexpected error:', err);
    });