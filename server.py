from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import subprocess
import uvicorn
from datetime import datetime
import os
import signal
try:
    import psutil
    PSUTIL_AVAILABLE = True
except ImportError:
    PSUTIL_AVAILABLE = False

app = FastAPI()

# Store running process references
vinyl_process = None
cd_process = None

# CORS Setup (Equivalent to CORS(app))
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows all origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def run_command(cmd: str):
    """Runs a command where we don't care about the text output."""
    try:
        subprocess.run(cmd, shell=True, check=True)
        return True
    except subprocess.CalledProcessError:
        return False

def get_command_output(cmd: str):
    """Runs a command and returns the text output as a list of strings."""
    try:
        result = subprocess.run(cmd, shell=True, check=True, capture_output=True, text=True)
        return result.stdout.strip().split('\n')
    except subprocess.CalledProcessError:
        return []

def is_process_running(process):
    """Check if a process is still running."""
    if process is None:
        return False
    try:
        # Check if process is still alive
        process.poll()
        return process.returncode is None
    except:
        return False

def find_running_ffmpeg_process(pattern):
    """Check if an ffmpeg process matching the pattern is already running."""
    if not PSUTIL_AVAILABLE:
        return False
    try:
        for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
            try:
                if proc.info['name'] and 'ffmpeg' in proc.info['name'].lower():
                    cmdline = ' '.join(proc.info['cmdline'] or [])
                    if pattern in cmdline:
                        return True
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except:
        pass
    return False

# Note: We use standard 'def' (not 'async def') so FastAPI runs these 
# blocking subprocess calls in a threadpool, keeping the server responsive.

@app.post('/eject')
def eject():
    run_command('eject')
    return {"status": "ejected"}

@app.post('/next')
def next_track():
    run_command('mpc next')
    return {"status": "skipped"}

@app.post('/prev')
def prev_track():
    run_command('mpc prev')
    return {"status": "previous"}

@app.get('/tracks')
def list_tracks():
    tracks = get_command_output('mpc playlist')
    return {"tracks": tracks}

@app.post('/play')
def play():
    run_command('mpc play')
    return {"status": "playing"}

@app.post('/stop')
def stop():
    run_command('mpc stop')
    return {"status": "stopped"}

@app.post('/pause')
def pause():
    run_command('mpc toggle')
    return {"status": "toggled"}

# Stream Control Endpoints

@app.post('/start_vinyl')
def start_vinyl():
    """Start the vinyl stream if not already running."""
    global vinyl_process
    
    # Check if process is already running
    if is_process_running(vinyl_process):
        return {"status": "already_running", "message": "Vinyl stream is already running"}
    
    # Check if ffmpeg process for vinyl is already running
    if find_running_ffmpeg_process('/vinyl'):
        return {"status": "already_running", "message": "Vinyl stream is already running"}
    
    # Start the vinyl stream
    cmd = 'ffmpeg -thread_queue_size 4096 -f alsa -ac 2 -ar 48000 -i hw:CARD=Device,DEV=0 -c:a libopus -b:a 64k -vbr off -application lowdelay -af "aresample=async=1000" -rtsp_transport tcp -f rtsp rtsp://localhost:8554/vinyl'
    try:
        vinyl_process = subprocess.Popen(
            cmd,
            shell=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            preexec_fn=os.setsid  # Create new process group
        )
        return {"status": "started", "message": "Vinyl stream started", "pid": vinyl_process.pid}
    except Exception as e:
        return {"status": "error", "message": f"Failed to start vinyl stream: {str(e)}"}

@app.post('/start_cd')
def start_cd():
    """Start the CD stream if not already running."""
    global cd_process
    
    # Check if process is already running
    if is_process_running(cd_process):
        return {"status": "already_running", "message": "CD stream is already running"}
    
    # Check if ffmpeg process for CD is already running
    if find_running_ffmpeg_process('/cd'):
        return {"status": "already_running", "message": "CD stream is already running"}
    
    # Start the CD stream
    cmd = 'cdparanoia -d /dev/sr0 -w 1- - | ffmpeg -re -thread_queue_size 4096 -f wav -i - -c:a libopus -b:a 64k -vbr off -application lowdelay -rtsp_transport tcp -f rtsp rtsp://localhost:8554/cd'
    try:
        cd_process = subprocess.Popen(
            cmd,
            shell=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            preexec_fn=os.setsid  # Create new process group
        )
        return {"status": "started", "message": "CD stream started", "pid": cd_process.pid}
    except Exception as e:
        return {"status": "error", "message": f"Failed to start CD stream: {str(e)}"}

# System Information Endpoints

def get_cpu_temperature():
    """Get CPU temperature from thermal zone (Raspberry Pi)."""
    try:
        # Try Raspberry Pi thermal zone
        with open('/sys/class/thermal/thermal_zone0/temp', 'r') as f:
            temp = int(f.read().strip()) / 1000.0  # Convert from millidegrees
            return temp
    except (FileNotFoundError, IOError):
        # Fallback to psutil if available
        if PSUTIL_AVAILABLE:
            try:
                temps = psutil.sensors_temperatures()
                if temps:
                    # Get first available temperature sensor
                    for name, entries in temps.items():
                        if entries:
                            return entries[0].current
            except:
                pass
    return None

def get_system_info():
    """Get comprehensive system information."""
    info = {}
    
    # CPU Temperature
    cpu_temp = get_cpu_temperature()
    if cpu_temp is not None:
        info['cpu_temperature'] = round(cpu_temp, 1)
        info['cpu_temperature_unit'] = 'celsius'
    
    # CPU Usage
    if PSUTIL_AVAILABLE:
        info['cpu_percent'] = round(psutil.cpu_percent(interval=0.1), 1)
        info['cpu_count'] = psutil.cpu_count()
        info['cpu_freq'] = {
            'current': round(psutil.cpu_freq().current, 0) if psutil.cpu_freq() else None,
            'min': round(psutil.cpu_freq().min, 0) if psutil.cpu_freq() else None,
            'max': round(psutil.cpu_freq().max, 0) if psutil.cpu_freq() else None,
        }
    
    # Memory Usage
    if PSUTIL_AVAILABLE:
        mem = psutil.virtual_memory()
        info['memory'] = {
            'total': round(mem.total / (1024**3), 2),  # GB
            'available': round(mem.available / (1024**3), 2),  # GB
            'used': round(mem.used / (1024**3), 2),  # GB
            'percent': round(mem.percent, 1)
        }
    
    # Disk Usage
    if PSUTIL_AVAILABLE:
        disk = psutil.disk_usage('/')
        info['disk'] = {
            'total': round(disk.total / (1024**3), 2),  # GB
            'used': round(disk.used / (1024**3), 2),  # GB
            'free': round(disk.free / (1024**3), 2),  # GB
            'percent': round((disk.used / disk.total) * 100, 1)
        }
    
    # Uptime
    if PSUTIL_AVAILABLE:
        boot_time = datetime.fromtimestamp(psutil.boot_time())
        uptime = datetime.now() - boot_time
        info['uptime'] = {
            'days': uptime.days,
            'hours': uptime.seconds // 3600,
            'minutes': (uptime.seconds % 3600) // 60,
            'seconds': uptime.seconds % 60,
            'total_seconds': int(uptime.total_seconds())
        }
    
    # Network Info
    if PSUTIL_AVAILABLE:
        net_io = psutil.net_io_counters()
        info['network'] = {
            'bytes_sent': net_io.bytes_sent,
            'bytes_recv': net_io.bytes_recv,
            'packets_sent': net_io.packets_sent,
            'packets_recv': net_io.packets_recv
        }
    
    # GPU Temperature (if available on Pi)
    try:
        result = subprocess.run(['vcgencmd', 'measure_temp'], capture_output=True, text=True, timeout=2)
        if result.returncode == 0:
            temp_str = result.stdout.strip()
            gpu_temp = float(temp_str.replace('temp=', '').replace("'C", ''))
            info['gpu_temperature'] = round(gpu_temp, 1)
            info['gpu_temperature_unit'] = 'celsius'
    except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
        pass
    
    # GPU Memory (if available on Pi)
    try:
        result = subprocess.run(['vcgencmd', 'get_mem', 'gpu'], capture_output=True, text=True, timeout=2)
        if result.returncode == 0:
            mem_str = result.stdout.strip()
            info['gpu_memory'] = mem_str.replace('gpu=', '')
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    
    return info

@app.get('/temperature')
def get_temperature():
    """Get CPU and GPU temperature."""
    cpu_temp = get_cpu_temperature()
    result = {"cpu_temperature": None, "gpu_temperature": None}
    
    if cpu_temp is not None:
        result["cpu_temperature"] = round(cpu_temp, 1)
        result["cpu_temperature_unit"] = "celsius"
    
    # Try to get GPU temperature (Raspberry Pi)
    try:
        gpu_result = subprocess.run(['vcgencmd', 'measure_temp'], capture_output=True, text=True, timeout=2)
        if gpu_result.returncode == 0:
            temp_str = gpu_result.stdout.strip()
            gpu_temp = float(temp_str.replace('temp=', '').replace("'C", ''))
            result["gpu_temperature"] = round(gpu_temp, 1)
            result["gpu_temperature_unit"] = "celsius"
    except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
        pass
    
    return result

@app.get('/system')
def get_system():
    """Get comprehensive system information."""
    return get_system_info()

@app.get('/health')
def health_check():
    """Simple health check endpoint."""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "psutil_available": PSUTIL_AVAILABLE
    }

if __name__ == '__main__':
    # Run with: python server.py
    uvicorn.run(app, host='0.0.0.0', port=5000)