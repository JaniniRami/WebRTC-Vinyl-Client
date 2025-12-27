import { useState, useEffect, useRef } from 'react'

function App() {
  const videoRef = useRef(null)
  const audioRef = useRef(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [error, setError] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('vinyl') // 'vinyl' or 'cd'
  const [systemInfo, setSystemInfo] = useState(null)
  const [temperature, setTemperature] = useState(null)
  const peerConnectionRef = useRef(null)
  const audioContextRef = useRef(null)
  const sourceNodeRef = useRef(null)
  const gainNodeRef = useRef(null)
  const analyserRef = useRef(null)
  const analysisIntervalRef = useRef(null)

  const SERVER_URL = 'http://192.168.1.21:5000'

  const STREAM_URLS = {
    vinyl: 'http://192.168.1.21:8889/vinyl/',
    cd: 'http://192.168.1.21:8889/cd/'
  }

  const getStreamUrl = () => STREAM_URLS[activeTab]

  // Fetch system information
  const fetchSystemInfo = async () => {
    try {
      const response = await fetch(`${SERVER_URL}/system`)
      if (response.ok) {
        const data = await response.json()
        setSystemInfo(data)
      }
    } catch (err) {
      console.error('Failed to fetch system info:', err)
    }
  }

  const fetchTemperature = async () => {
    try {
      const response = await fetch(`${SERVER_URL}/temperature`)
      if (response.ok) {
        const data = await response.json()
        setTemperature(data)
      }
    } catch (err) {
      console.error('Failed to fetch temperature:', err)
    }
  }

  // Fetch system info periodically
  useEffect(() => {
    fetchSystemInfo()
    fetchTemperature()
    const interval = setInterval(() => {
      fetchSystemInfo()
      fetchTemperature()
    }, 5000) // Update every 5 seconds

    return () => clearInterval(interval)
  }, [])

  // CD Player Controls
  const cdControl = async (action) => {
    try {
      const response = await fetch(`${SERVER_URL}/${action}`, {
        method: 'POST'
      })
      if (response.ok) {
        const data = await response.json()
        console.log(`CD ${action}:`, data)
      }
    } catch (err) {
      console.error(`Failed to ${action}:`, err)
      setError(`Failed to ${action} CD player`)
    }
  }

  // Frequency analysis function to identify noise frequencies
  const startFrequencyAnalysis = () => {
    if (!analyserRef.current) return

    // Clear any existing interval
    if (analysisIntervalRef.current) {
      clearInterval(analysisIntervalRef.current)
    }

    const sampleRate = audioContextRef.current?.sampleRate || 44100
    const bufferLength = analyserRef.current.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)

    const analyze = () => {
      if (!analyserRef.current) return

      analyserRef.current.getByteFrequencyData(dataArray)

      // Find dominant frequencies (peaks in the spectrum)
      const peaks = []
      const threshold = 50 // Minimum amplitude to consider

      for (let i = 0; i < bufferLength; i++) {
        const amplitude = dataArray[i]
        if (amplitude > threshold) {
          // Convert bin index to frequency
          const frequency = (i * sampleRate) / (bufferLength * 2)
          peaks.push({ frequency, amplitude })
        }
      }

      // Sort by amplitude and get top frequencies
      peaks.sort((a, b) => b.amplitude - a.amplitude)
      const topFrequencies = peaks.slice(0, 10)

      // Frequency analysis data available but not logged
      // Can be used for visualization or other purposes if needed
    }

    // Analyze every 2 seconds
    analysisIntervalRef.current = setInterval(analyze, 2000)
    // Also analyze immediately
    analyze()
  }

  const stopFrequencyAnalysis = () => {
    if (analysisIntervalRef.current) {
      clearInterval(analysisIntervalRef.current)
      analysisIntervalRef.current = null
    }
  }

  useEffect(() => {
    // Initialize audio context for filtering (only once)
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)()
    }

    // Ensure audio is muted when not playing
    if (audioRef.current) {
      audioRef.current.muted = !isPlaying
      if (!isPlaying) {
        audioRef.current.volume = 0
      } else {
        audioRef.current.volume = 0 // Keep muted, using Web Audio API output
      }
    }
  }, [isPlaying])

  useEffect(() => {
    // Cleanup on unmount only
    return () => {
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close()
      }
      if (sourceNodeRef.current) {
        try {
          sourceNodeRef.current.disconnect()
        } catch (e) {
          // Ignore disconnect errors
        }
        sourceNodeRef.current = null
      }
      if (gainNodeRef.current) {
        try {
          gainNodeRef.current.disconnect()
        } catch (e) {
          // Ignore disconnect errors
        }
        gainNodeRef.current = null
      }
      stopFrequencyAnalysis()
      // Don't close audio context on unmount - let it stay alive
      // Only close if explicitly needed
    }
  }, [])

  const startStream = async () => {
    setIsLoading(true)
    setError(null)

    try {
      // Start the appropriate stream on the server
      const streamEndpoint = activeTab === 'vinyl' ? '/start_vinyl' : '/start_cd'
      const streamResponse = await fetch(`${SERVER_URL}${streamEndpoint}`, {
        method: 'POST'
      })
      
      if (streamResponse.ok) {
        const streamData = await streamResponse.json()
        console.log(`Stream ${activeTab} start:`, streamData)
        
        // Small delay to allow stream to initialize
        await new Promise(resolve => setTimeout(resolve, 1000))
      } else {
        console.warn(`Failed to start ${activeTab} stream on server`)
      }
    } catch (err) {
      console.error(`Failed to start ${activeTab} stream:`, err)
      // Continue anyway - stream might already be running
    }

    try {
      // Try WebRTC first (for mediamtx)
      await connectWebRTC()
    } catch (err) {
      console.error('WebRTC failed, trying fallback:', err)
      setError(`WebRTC error: ${err.message}`)
      // Fallback to HLS or direct stream
      try {
        await connectFallback()
      } catch (fallbackErr) {
        setError(`Connection failed: ${err.message}. Fallback also failed: ${fallbackErr.message}`)
        console.error('Fallback also failed:', fallbackErr)
        setIsLoading(false)
      }
    }
  }

  const connectWebRTC = async () => {
    // MediaMTX WebRTC connection using WHEP protocol
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    })

    peerConnectionRef.current = pc

    // Add audio transceiver for receiving audio
    pc.addTransceiver('audio', { direction: 'recvonly' })

    // Handle incoming stream
    pc.ontrack = async (event) => {
      console.log('Received track:', event)
      let stream = null
      
      if (event.streams && event.streams[0]) {
        stream = event.streams[0]
      } else if (event.track) {
        stream = new MediaStream([event.track])
      }

      if (stream) {
        try {
          // Ensure audio context is active
          if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
            audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)()
          }

          // Resume audio context if suspended
          if (audioContextRef.current.state === 'suspended') {
            await audioContextRef.current.resume()
          }

          // Wait for context to be ready
          if (audioContextRef.current.state !== 'running') {
            await audioContextRef.current.resume()
          }

          // Disconnect previous source if exists
          if (sourceNodeRef.current) {
            try {
              sourceNodeRef.current.disconnect()
            } catch (e) {
              // Ignore disconnect errors
            }
            sourceNodeRef.current = null
          }

          // Verify context is still active before creating nodes
          if (audioContextRef.current.state === 'closed') {
            throw new Error('AudioContext is closed')
          }

          // Create source from stream
          sourceNodeRef.current = audioContextRef.current.createMediaStreamSource(stream)

          // Verify context is still active before creating filter nodes
          if (audioContextRef.current.state === 'closed') {
            throw new Error('AudioContext closed before creating filters')
          }

          // Create audio filter chain to reduce white noise
          // High-pass filter to remove low-frequency noise (raised to cut more aggressively)
          const highPassFilter = audioContextRef.current.createBiquadFilter()
          highPassFilter.type = 'highpass'
          highPassFilter.frequency.value = 250 // Cut frequencies below 250Hz (more aggressive)
          highPassFilter.Q.value = 2 // Steeper cutoff

          // Notch filters for all identified noise frequencies
          // Primary noise frequencies
          const notchFilter1 = audioContextRef.current.createBiquadFilter()
          notchFilter1.type = 'notch'
          notchFilter1.frequency.value = 93.75
          notchFilter1.Q.value = 20

          const notchFilter2 = audioContextRef.current.createBiquadFilter()
          notchFilter2.type = 'notch'
          notchFilter2.frequency.value = 117.19
          notchFilter2.Q.value = 20

          const notchFilter3 = audioContextRef.current.createBiquadFilter()
          notchFilter3.type = 'notch'
          notchFilter3.frequency.value = 140.63
          notchFilter3.Q.value = 18

          const notchFilter4 = audioContextRef.current.createBiquadFilter()
          notchFilter4.type = 'notch'
          notchFilter4.frequency.value = 164.06
          notchFilter4.Q.value = 18

          const notchFilter5 = audioContextRef.current.createBiquadFilter()
          notchFilter5.type = 'notch'
          notchFilter5.frequency.value = 187.50
          notchFilter5.Q.value = 18

          const notchFilter6 = audioContextRef.current.createBiquadFilter()
          notchFilter6.type = 'notch'
          notchFilter6.frequency.value = 210.94
          notchFilter6.Q.value = 18

          const notchFilter7 = audioContextRef.current.createBiquadFilter()
          notchFilter7.type = 'notch'
          notchFilter7.frequency.value = 234.38
          notchFilter7.Q.value = 18

          const notchFilter8 = audioContextRef.current.createBiquadFilter()
          notchFilter8.type = 'notch'
          notchFilter8.frequency.value = 257.81
          notchFilter8.Q.value = 18

          // Additional lower frequency notches
          const notchFilter9 = audioContextRef.current.createBiquadFilter()
          notchFilter9.type = 'notch'
          notchFilter9.frequency.value = 70.31
          notchFilter9.Q.value = 15

          const notchFilter10 = audioContextRef.current.createBiquadFilter()
          notchFilter10.type = 'notch'
          notchFilter10.frequency.value = 46.88
          notchFilter10.Q.value = 15

          // Low-pass filter to remove high-frequency noise
          const lowPassFilter = audioContextRef.current.createBiquadFilter()
          lowPassFilter.type = 'lowpass'
          lowPassFilter.frequency.value = 15000 // Cut frequencies above 15kHz
          lowPassFilter.Q.value = 1

          // Gain node for volume control and noise gate effect
          gainNodeRef.current = audioContextRef.current.createGain()
          gainNodeRef.current.gain.value = 1.0

          // Create analyser node for frequency analysis
          analyserRef.current = audioContextRef.current.createAnalyser()
          analyserRef.current.fftSize = 2048
          analyserRef.current.smoothingTimeConstant = 0.8

          // Verify context is still active before connecting
          if (audioContextRef.current.state === 'closed') {
            throw new Error('AudioContext closed before connecting nodes')
          }

          // Connect the filter chain with analyser for frequency detection
          sourceNodeRef.current
            .connect(highPassFilter)
            .connect(notchFilter1) // 93.75 Hz
            .connect(notchFilter2) // 117.19 Hz
            .connect(notchFilter3) // 140.63 Hz
            .connect(notchFilter4) // 164.06 Hz
            .connect(notchFilter5) // 187.50 Hz
            .connect(notchFilter6) // 210.94 Hz
            .connect(notchFilter7) // 234.38 Hz
            .connect(notchFilter8) // 257.81 Hz
            .connect(notchFilter9) // 70.31 Hz
            .connect(notchFilter10) // 46.88 Hz
            .connect(lowPassFilter)
            .connect(analyserRef.current) // Analyze before final gain
            .connect(gainNodeRef.current)
            .connect(audioContextRef.current.destination)

          // Start frequency analysis
          startFrequencyAnalysis()

          // Also connect to audio element for fallback
          if (audioRef.current) {
            audioRef.current.srcObject = stream
            audioRef.current.volume = 0 // Mute the direct audio, use filtered version
            await audioRef.current.play()
          }

          setIsPlaying(true)
          setIsLoading(false)
        } catch (err) {
          console.error('Audio processing error:', err)
          // Fallback to direct audio if processing fails
          if (audioRef.current && stream) {
            audioRef.current.srcObject = stream
            audioRef.current.volume = 1
            await audioRef.current.play()
            setIsPlaying(true)
            setIsLoading(false)
          } else {
            setError('Failed to process audio stream')
            setIsLoading(false)
          }
        }
      }
    }

    // Handle ICE connection state
    pc.oniceconnectionstatechange = () => {
      console.log('ICE connection state:', pc.iceConnectionState)
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        setError('Connection lost')
        setIsPlaying(false)
      } else if (pc.iceConnectionState === 'connected' && !isPlaying) {
        // Connection established but not playing yet - this is normal
        console.log('ICE connected, waiting for track...')
      }
    }

    // Create offer with proper configuration
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false
    })
    
    await pc.setLocalDescription(offer)

    // Wait a bit for ICE candidates to be gathered
    await new Promise(resolve => setTimeout(resolve, 100))

    const streamUrl = getStreamUrl()
    // Try different WHEP endpoint formats
    const whepEndpoints = [
      `${streamUrl}whep`,
      `${streamUrl.replace(/\/$/, '')}/whep`,
      `${streamUrl}webrtc`
    ]

    let answerSdp = null
    let lastError = null

    for (const endpoint of whepEndpoints) {
      try {
        // Send offer to MediaMTX WHEP endpoint
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/sdp',
            'Accept': 'application/sdp'
          },
          body: offer.sdp
        })

        if (!response.ok) {
          const errorText = await response.text()
          lastError = new Error(`HTTP error! status: ${response.status}, message: ${errorText}`)
          continue
        }

        // Try to get answer - could be text or JSON
        const contentType = response.headers.get('content-type') || ''
        if (contentType.includes('application/json')) {
          const json = await response.json()
          answerSdp = json.sdp || json.answer || json
        } else {
          answerSdp = await response.text()
        }
        
        // Validate SDP has required fields
        if (answerSdp && (answerSdp.includes('m=audio') || answerSdp.includes('m=video'))) {
          break
        } else {
          lastError = new Error('Invalid SDP answer format')
        }
      } catch (err) {
        lastError = err
        continue
      }
    }

    if (!answerSdp) {
      throw lastError || new Error('Failed to get SDP answer from any endpoint')
    }

    try {
      await pc.setRemoteDescription({
        type: 'answer',
        sdp: answerSdp
      })
    } catch (err) {
      console.error('Error setting remote description:', err)
      console.error('SDP answer:', answerSdp.substring(0, 200))
      throw new Error(`Failed to set remote description: ${err.message}`)
    }
  }

  const connectFallback = async () => {
    // Fallback: Try HLS or direct audio stream
    if (audioRef.current) {
      try {
        // Ensure audio context is active
        if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
          audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)()
        }

        // Resume audio context if suspended
        if (audioContextRef.current.state === 'suspended') {
          await audioContextRef.current.resume()
        }

        // Wait for context to be ready
        if (audioContextRef.current.state !== 'running') {
          await audioContextRef.current.resume()
        }

        const streamUrl = getStreamUrl()
        // Try as direct audio source
        audioRef.current.src = `${streamUrl}stream.m3u8` // HLS
        audioRef.current.crossOrigin = 'anonymous'
        audioRef.current.volume = 0 // Mute direct audio, we'll process it
        
        const handleLoadedData = async () => {
          try {
            // Verify context is still active
            if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
              audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)()
              await audioContextRef.current.resume()
            }

            // Create source from audio element
            if (sourceNodeRef.current) {
              try {
                sourceNodeRef.current.disconnect()
              } catch (e) {
                // Ignore disconnect errors
              }
              sourceNodeRef.current = null
            }

            if (audioContextRef.current.state === 'closed') {
              throw new Error('AudioContext is closed')
            }

            sourceNodeRef.current = audioContextRef.current.createMediaElementSource(audioRef.current)

            // Verify context is still active before creating filters
            if (audioContextRef.current.state === 'closed') {
              throw new Error('AudioContext closed before creating filters')
            }

            // Create filter chain (same as WebRTC)
            const highPassFilter = audioContextRef.current.createBiquadFilter()
            highPassFilter.type = 'highpass'
            highPassFilter.frequency.value = 250 // Cut frequencies below 250Hz
            highPassFilter.Q.value = 2

            // Notch filters for all identified noise frequencies
            const notchFilter1 = audioContextRef.current.createBiquadFilter()
            notchFilter1.type = 'notch'
            notchFilter1.frequency.value = 93.75
            notchFilter1.Q.value = 20

            const notchFilter2 = audioContextRef.current.createBiquadFilter()
            notchFilter2.type = 'notch'
            notchFilter2.frequency.value = 117.19
            notchFilter2.Q.value = 20

            const notchFilter3 = audioContextRef.current.createBiquadFilter()
            notchFilter3.type = 'notch'
            notchFilter3.frequency.value = 140.63
            notchFilter3.Q.value = 18

            const notchFilter4 = audioContextRef.current.createBiquadFilter()
            notchFilter4.type = 'notch'
            notchFilter4.frequency.value = 164.06
            notchFilter4.Q.value = 18

            const notchFilter5 = audioContextRef.current.createBiquadFilter()
            notchFilter5.type = 'notch'
            notchFilter5.frequency.value = 187.50
            notchFilter5.Q.value = 18

            const notchFilter6 = audioContextRef.current.createBiquadFilter()
            notchFilter6.type = 'notch'
            notchFilter6.frequency.value = 210.94
            notchFilter6.Q.value = 18

            const notchFilter7 = audioContextRef.current.createBiquadFilter()
            notchFilter7.type = 'notch'
            notchFilter7.frequency.value = 234.38
            notchFilter7.Q.value = 18

            const notchFilter8 = audioContextRef.current.createBiquadFilter()
            notchFilter8.type = 'notch'
            notchFilter8.frequency.value = 257.81
            notchFilter8.Q.value = 18

            const notchFilter9 = audioContextRef.current.createBiquadFilter()
            notchFilter9.type = 'notch'
            notchFilter9.frequency.value = 70.31
            notchFilter9.Q.value = 15

            const notchFilter10 = audioContextRef.current.createBiquadFilter()
            notchFilter10.type = 'notch'
            notchFilter10.frequency.value = 46.88
            notchFilter10.Q.value = 15

            const lowPassFilter = audioContextRef.current.createBiquadFilter()
            lowPassFilter.type = 'lowpass'
            lowPassFilter.frequency.value = 15000
            lowPassFilter.Q.value = 1

            gainNodeRef.current = audioContextRef.current.createGain()
            gainNodeRef.current.gain.value = 1.0

            // Create analyser node for frequency analysis
            analyserRef.current = audioContextRef.current.createAnalyser()
            analyserRef.current.fftSize = 2048
            analyserRef.current.smoothingTimeConstant = 0.8

            // Verify context is still active before connecting
            if (audioContextRef.current.state === 'closed') {
              throw new Error('AudioContext closed before connecting nodes')
            }

            sourceNodeRef.current
              .connect(highPassFilter)
              .connect(notchFilter1) // 93.75 Hz
              .connect(notchFilter2) // 117.19 Hz
              .connect(notchFilter3) // 140.63 Hz
              .connect(notchFilter4) // 164.06 Hz
              .connect(notchFilter5) // 187.50 Hz
              .connect(notchFilter6) // 210.94 Hz
              .connect(notchFilter7) // 234.38 Hz
              .connect(notchFilter8) // 257.81 Hz
              .connect(notchFilter9) // 70.31 Hz
              .connect(notchFilter10) // 46.88 Hz
              .connect(lowPassFilter)
              .connect(analyserRef.current) // Analyze before final gain
              .connect(gainNodeRef.current)
              .connect(audioContextRef.current.destination)

            // Start frequency analysis
            startFrequencyAnalysis()

            await audioRef.current.play()
            setIsPlaying(true)
            setIsLoading(false)
          } catch (err) {
            console.error('Play error:', err)
            const streamUrl = getStreamUrl()
            // Try direct stream URL without processing
            audioRef.current.src = streamUrl
            audioRef.current.volume = 1
            await audioRef.current.play()
            setIsPlaying(true)
            setIsLoading(false)
          }
        }

        audioRef.current.addEventListener('loadeddata', handleLoadedData, { once: true })

        audioRef.current.addEventListener('error', () => {
          // Try direct URL
          const streamUrl = getStreamUrl()
          audioRef.current.src = streamUrl
          audioRef.current.load()
        })

        audioRef.current.load()
      } catch (err) {
        setError(`Failed to connect: ${err.message}`)
        setIsLoading(false)
      }
    }
  }

  const handleTabChange = (tab) => {
    // If currently playing, stop first
    if (isPlaying) {
      stopStream()
    }
    setActiveTab(tab)
    setError(null)
  }

  const stopStream = () => {
    // Stop frequency analysis
    stopFrequencyAnalysis()

    // Disconnect audio processing nodes
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.disconnect()
      } catch (e) {
        // Ignore disconnect errors
      }
      sourceNodeRef.current = null
    }
    if (gainNodeRef.current) {
      try {
        gainNodeRef.current.disconnect()
      } catch (e) {
        // Ignore disconnect errors
      }
      gainNodeRef.current = null
    }
    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect()
      } catch (e) {
        // Ignore disconnect errors
      }
      analyserRef.current = null
    }

    // Stop audio element
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.srcObject = null
      audioRef.current.src = ''
      audioRef.current.volume = 1 // Reset volume
    }

    // Close peer connection
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close()
      peerConnectionRef.current = null
    }

    setIsPlaying(false)
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Top Taskbar - System Status */}
      <div className="bg-gradient-to-b from-amber-900 to-amber-950 vintage-border-b border-b-4 border-amber-800 shadow-lg px-4 py-2 flex items-center justify-between gap-4 flex-shrink-0">
        <div className="text-xs font-bold text-amber-100 vintage-text-shadow tracking-wider uppercase">
          SYSTEM STATUS
        </div>
        
        <div className="flex items-center gap-6 flex-1 justify-center">
          {/* Temperature */}
          {temperature && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-amber-300 font-semibold">TEMP:</span>
              {temperature.cpu_temperature && (
                <span className="text-xs font-mono text-amber-200">CPU {temperature.cpu_temperature}°C</span>
              )}
              {temperature.gpu_temperature && (
                <span className="text-xs font-mono text-amber-200">GPU {temperature.gpu_temperature}°C</span>
              )}
            </div>
          )}

          {/* CPU */}
          {systemInfo && systemInfo.cpu_percent !== undefined && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-amber-300 font-semibold">CPU:</span>
              <span className="text-xs font-mono text-amber-200">{systemInfo.cpu_percent}%</span>
              {systemInfo.cpu_freq?.current && (
                <span className="text-xs font-mono text-amber-400">({systemInfo.cpu_freq.current} MHz)</span>
              )}
            </div>
          )}

          {/* Memory */}
          {systemInfo && systemInfo.memory && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-amber-300 font-semibold">MEM:</span>
              <span className="text-xs font-mono text-amber-200">{systemInfo.memory.used}GB / {systemInfo.memory.total}GB ({systemInfo.memory.percent}%)</span>
            </div>
          )}

          {/* Disk */}
          {systemInfo && systemInfo.disk && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-amber-300 font-semibold">DISK:</span>
              <span className="text-xs font-mono text-amber-200">{systemInfo.disk.used}GB / {systemInfo.disk.total}GB ({systemInfo.disk.percent}%)</span>
            </div>
          )}

          {/* Uptime */}
          {systemInfo && systemInfo.uptime && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-amber-300 font-semibold">UPTIME:</span>
              <span className="text-xs font-mono text-amber-200">
                {systemInfo.uptime.days > 0 && `${systemInfo.uptime.days}d `}
                {systemInfo.uptime.hours > 0 && `${systemInfo.uptime.hours}h `}
                {systemInfo.uptime.minutes}m
              </span>
            </div>
          )}

          {/* GPU Memory */}
          {systemInfo && systemInfo.gpu_memory && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-amber-300 font-semibold">GPU:</span>
              <span className="text-xs font-mono text-amber-200">{systemInfo.gpu_memory}</span>
            </div>
          )}
        </div>

        {!systemInfo && !temperature && (
          <div className="text-xs text-amber-400 animate-pulse">Loading...</div>
        )}
      </div>

      {/* Main Player - Centered */}
      <div className="flex-1 flex items-center justify-center p-4 overflow-hidden mt-4">
        <div className="w-full max-w-2xl">
          <div className="bg-gradient-to-b from-amber-800 to-amber-900 vintage-border rounded-lg p-4 shadow-2xl">
          {/* Tabs */}
          <div className="flex gap-2 mb-4 justify-center">
            <button
              onClick={() => handleTabChange('vinyl')}
              className={`px-6 py-2 font-bold tracking-wider uppercase border-2 transition-all duration-200 ${
                activeTab === 'vinyl'
                  ? 'bg-amber-700 border-amber-950 text-amber-50 shadow-lg vintage-text-shadow'
                  : 'bg-amber-900 border-amber-800 text-amber-300 hover:bg-amber-800'
              }`}
            >
              VINYL
            </button>
            <button
              onClick={() => handleTabChange('cd')}
              className={`px-6 py-2 font-bold tracking-wider uppercase border-2 transition-all duration-200 ${
                activeTab === 'cd'
                  ? 'bg-amber-700 border-amber-950 text-amber-50 shadow-lg vintage-text-shadow'
                  : 'bg-amber-900 border-amber-800 text-amber-300 hover:bg-amber-800'
              }`}
            >
              CD
            </button>
          </div>

          {/* Player Top */}
          <div className="text-center mb-4 pb-2 border-b-2 border-amber-700">
            <div className="text-2xl font-bold text-amber-100 vintage-text-shadow tracking-wider mb-1">
              {activeTab === 'vinyl' ? 'VINYL PLAYER' : 'CD PLAYER'}
            </div>
            <div className="text-sm text-amber-200 font-semibold tracking-widest">
              {activeTab === 'vinyl' ? 'Model 1950' : 'Model 1980'}
            </div>
          </div>
          
          {/* Turntable/CD Container */}
          <div className="flex justify-center mb-4">
            <div className="relative w-64 h-64">
              {/* Base */}
              <div className="absolute inset-0 bg-gradient-radial from-gray-800 via-gray-700 to-gray-800 rounded-full shadow-inner border-4 border-amber-900"></div>
              
              {activeTab === 'vinyl' ? (
                <>
                  {/* Vinyl Record - Spinning Part */}
                  <div 
                    className="absolute inset-4 rounded-full bg-gradient-radial from-gray-900 via-gray-800 to-gray-900"
                    style={{ 
                      transformOrigin: 'center center',
                      animation: isPlaying ? 'spin-vinyl 3.5s linear infinite' : 'none',
                      willChange: isPlaying ? 'transform' : 'auto'
                    }}
                  >
                    {/* Record Grooves */}
                    <div className="absolute inset-0 rounded-full">
                      {Array.from({ length: 20 }).map((_, i) => (
                        <div
                          key={i}
                          className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 rounded-full border border-gray-600 opacity-30"
                          style={{
                            width: `${20 + i * 8}%`,
                            height: `${20 + i * 8}%`,
                            transform: `translate(-50%, -50%) rotate(${i * 18}deg)`,
                          }}
                        ></div>
                      ))}
                    </div>
                  </div>
                  
                  {/* Record Center - Fixed (doesn't spin) */}
                  <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-16 h-16 bg-gray-700 rounded-full border-2 border-gray-600 shadow-inner z-10"></div>
                  <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-gray-900 rounded-full z-10"></div>
                </>
              ) : (
                <>
                  {/* CD - Spinning Part */}
                  <div 
                    className="absolute inset-4 rounded-full bg-gradient-radial from-silver-400 via-silver-300 to-silver-500"
                    style={{ 
                      transformOrigin: 'center center',
                      animation: isPlaying ? 'spin-vinyl 2s linear infinite' : 'none',
                      willChange: isPlaying ? 'transform' : 'auto',
                      background: 'radial-gradient(circle, #c0c0c0 0%, #a8a8a8 50%, #d0d0d0 100%)'
                    }}
                  >
                    {/* CD Shine/Reflection */}
                    <div className="absolute inset-0 rounded-full bg-gradient-to-br from-white opacity-20"></div>
                    {/* CD Center Hole */}
                    <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-12 h-12 bg-gray-800 rounded-full border-2 border-gray-700 shadow-inner z-10"></div>
                    <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-6 h-6 bg-gray-900 rounded-full z-10"></div>
                  </div>
                </>
              )}

              {/* Tonearm - Only for Vinyl */}
              {activeTab === 'vinyl' && (
                <div className="absolute top-0 left-1/2 transform -translate-x-1/2 origin-top pointer-events-none">
                  <div className="relative">
                    {/* Tonearm Base */}
                    <div className="absolute -top-2 left-1/2 transform -translate-x-1/2 w-6 h-6 bg-amber-800 rounded-full border-2 border-amber-900 shadow-lg"></div>
                    {/* Tonearm Arm */}
                    <div 
                      className={`w-1 h-32 bg-gradient-to-b from-amber-700 to-amber-900 rounded-full shadow-lg transition-transform duration-500 ${isPlaying ? 'rotate-12' : 'rotate-0'}`}
                      style={{ transformOrigin: 'top center' }}
                    ></div>
                    {/* Tonearm Head */}
                    <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-8 h-8 bg-amber-900 rounded-full border-2 border-amber-950 shadow-inner"></div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Player Controls */}
          <div className="mb-4 relative z-20">
            <div className="flex items-center justify-center gap-8">
              {/* Volume Knob */}
              <div className="flex flex-col items-center">
                <div className="text-xs text-amber-200 font-semibold tracking-wider mb-2">VOLUME</div>
                <div className="w-16 h-16 bg-gradient-radial from-amber-700 to-amber-900 rounded-full border-4 border-amber-950 shadow-inner flex items-center justify-center">
                  <div className="w-2 h-2 bg-amber-950 rounded-full"></div>
                </div>
              </div>

              {/* Control Buttons */}
              <div className="relative z-20">
                {!isPlaying ? (
                  <button 
                    className="relative z-10 px-8 py-3 bg-gradient-to-b from-amber-600 to-amber-800 text-amber-50 font-bold tracking-wider uppercase border-2 border-amber-950 shadow-lg hover:from-amber-700 hover:to-amber-900 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed vintage-text-shadow"
                    onClick={startStream}
                    disabled={isLoading}
                  >
                    {isLoading ? 'CONNECTING...' : 'PLAY'}
                  </button>
                ) : (
                  <button 
                    className="relative z-10 px-8 py-3 bg-gradient-to-b from-red-700 to-red-900 text-red-50 font-bold tracking-wider uppercase border-2 border-red-950 shadow-lg hover:from-red-800 hover:to-red-950 transition-all duration-200 vintage-text-shadow"
                    onClick={stopStream}
                  >
                    STOP
                  </button>
                )}
              </div>
            </div>

            {/* CD Player Controls - Always reserve space to maintain same height */}
            <div className={`mt-4 pt-4 border-t-2 border-amber-700 ${activeTab === 'cd' ? '' : 'invisible'}`}>
              <div className="text-center mb-3">
                <div className="text-sm text-amber-200 font-semibold tracking-wider mb-2">CD CONTROLS</div>
                <div className="flex flex-wrap gap-2 justify-center">
                  <button
                    onClick={() => cdControl('prev')}
                    disabled={activeTab !== 'cd'}
                    className="px-4 py-2 bg-amber-800 text-amber-50 font-bold text-xs tracking-wider uppercase border-2 border-amber-950 shadow-lg hover:bg-amber-900 transition-all vintage-text-shadow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    PREV
                  </button>
                  <button
                    onClick={() => cdControl('play')}
                    disabled={activeTab !== 'cd'}
                    className="px-4 py-2 bg-amber-800 text-amber-50 font-bold text-xs tracking-wider uppercase border-2 border-amber-950 shadow-lg hover:bg-amber-900 transition-all vintage-text-shadow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    PLAY
                  </button>
                  <button
                    onClick={() => cdControl('pause')}
                    disabled={activeTab !== 'cd'}
                    className="px-4 py-2 bg-amber-800 text-amber-50 font-bold text-xs tracking-wider uppercase border-2 border-amber-950 shadow-lg hover:bg-amber-900 transition-all vintage-text-shadow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    PAUSE
                  </button>
                  <button
                    onClick={() => cdControl('stop')}
                    disabled={activeTab !== 'cd'}
                    className="px-4 py-2 bg-amber-800 text-amber-50 font-bold text-xs tracking-wider uppercase border-2 border-amber-950 shadow-lg hover:bg-amber-900 transition-all vintage-text-shadow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    STOP
                  </button>
                  <button
                    onClick={() => cdControl('next')}
                    disabled={activeTab !== 'cd'}
                    className="px-4 py-2 bg-amber-800 text-amber-50 font-bold text-xs tracking-wider uppercase border-2 border-amber-950 shadow-lg hover:bg-amber-900 transition-all vintage-text-shadow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    NEXT
                  </button>
                  <button
                    onClick={() => cdControl('eject')}
                    disabled={activeTab !== 'cd'}
                    className="px-4 py-2 bg-red-800 text-red-50 font-bold text-xs tracking-wider uppercase border-2 border-red-950 shadow-lg hover:bg-red-900 transition-all vintage-text-shadow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    EJECT
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Status Display */}
          <div className="mb-4">
            <div className="bg-amber-950 border-2 border-amber-800 rounded px-4 py-2 text-center">
              <div className="text-sm font-mono text-amber-200 tracking-wider">
                {error ? (
                  <span className="text-red-400">ERROR: {error}</span>
                ) : isLoading ? (
                  <span className="text-amber-300 animate-pulse">CONNECTING...</span>
                ) : isPlaying ? (
                  <span className="text-green-400">NOW PLAYING</span>
                ) : (
                  <span>READY</span>
                )}
              </div>
            </div>
          </div>

          {/* Frequency Display */}
          <div className="flex justify-center gap-1 h-12 items-end">
            {Array.from({ length: 10 }).map((_, i) => (
              <div
                key={i}
                className={`w-3 bg-gradient-to-t from-amber-600 to-amber-400 rounded-t transition-all duration-300 ${
                  isPlaying ? 'animate-pulse-slow' : 'opacity-30'
                }`}
                style={{
                  height: isPlaying ? `${30 + Math.sin(i * 0.5) * 20 + Math.random() * 30}%` : '20%',
                  animationDelay: `${i * 0.1}s`,
                }}
              ></div>
            ))}
          </div>
        </div>
        </div>
      </div>

      {/* Hidden audio/video elements */}
      <audio ref={audioRef} autoPlay muted={!isPlaying} />
      <video ref={videoRef} className="hidden" />
    </div>
  )
}

export default App

