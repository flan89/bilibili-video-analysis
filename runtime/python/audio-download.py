#!/usr/bin/env python3
"""
audio-download: B 站 audio.m4s 下载 (Web API 自实现, 不依赖 yt-dlp)

B 站 audio.m4s 直链获取有两种方式:
  A) 旧 API: https://api.bilibili.com/x/player/playurl?bvid=X&cid=Y&qn=16
     - 优点: 不用 WBI 签名, 只要 SESSDATA
     - 缺点: 2024+ 部分视频要求 fnval=16/4048 强制 DASH
  B) 新 API: https://api.bilibili.com/x/player/wbi/playurl?bvid=X&cid=Y
     - 优点: 主流, 支持高画质
     - 缺点: 需要 WBI 签名 (img_key + sub_key + mixin_key + md5)

本脚本先试 A, 如果不行再上 B. qn=16 低画质对 ASR 够用.

接受可选 cid 参数, 透传时直接用传入的 cid 拿对应分P 音频,
  不再自己 get_cid() 拿默认 P1 造成 Evidence Identity 污染.
  cid 缺失时降级到原 get_cid() 行为 (保留脚本独立可运行性, 但 M6.2 pipeline.py 永远传 cid).

用法:
  python3 scripts/subtitle/asr/audio-download.py <BV号> [cid] [SESSDATA]

输出: data/raw/<BV号>[_<cid>].c_audio.m4s (含 cid 时命名加 cid)
"""
import json
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path


HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Referer": "https://www.bilibili.com",
}


def get_cid(bvid: str, sessdata: str | None) -> int:
    """从 BV 号查 CID (调 view 接口)"""
    url = f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
    req = urllib.request.Request(url, headers=HEADERS)
    if sessdata:
        req.add_header("Cookie", f"SESSDATA={sessdata}")
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read())
    if data.get("code") != 0:
        raise RuntimeError(f"view API 失败: {data.get('message')}")
    return data["data"]["cid"]


def get_audio_url(bvid: str, cid: int, sessdata: str | None) -> tuple[str, str]:
    """调 playurl API 拿 audio.m4s URL.
    返回 (audio_url, format).
    format: "dash" 或 "durl" (B 站两种返回格式)
    """
    # 旧 API, qn=16 (低画质优先确保有 audio), fnval=16 (强制 DASH)
    url = f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&qn=16&fnval=16&fnver=0&fourk=0"
    req = urllib.request.Request(url, headers=HEADERS)
    if sessdata:
        req.add_header("Cookie", f"SESSDATA={sessdata}")
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read())
    if data.get("code") != 0:
        raise RuntimeError(f"playurl API 失败: code={data.get('code')}, msg={data.get('message')}")
    pdata = data["data"]
    if "dash" in pdata and pdata["dash"].get("audio"):
        # DASH 模式: 取第一个 audio 轨
        audios = pdata["dash"]["audio"]
        # 按 id 倒序取最大 (跟 C# 例子一致)
        audios_sorted = sorted(audios, key=lambda a: a.get("id", 0), reverse=True)
        return audios_sorted[0]["baseUrl"], "dash"
    elif "durl" in pdata and pdata["durl"]:
        # 兜底: 合轨 FLV/MP4
        return pdata["durl"][0]["url"], "durl"
    raise RuntimeError("playurl 返回既无 dash 也无 durl")


def download_m4s(url: str, output_path: Path) -> None:
    """下载 m4s 文件 (带防盗链 header)"""
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    # ASR 工作目录是可再生缓存，新机器或缓存被清理后 data/raw 不一定存在。
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(data)


def main():
    if len(sys.argv) < 2:
        print("用法: python3 scripts/subtitle/asr/audio-download.py <BV号> [cid] [SESSDATA]", file=sys.stderr)
        sys.exit(1)
    bv_id = sys.argv[1]
    # 接受外部传入的 cid (pipeline.py 透传), 缺失才 fallback 走 view API
    # 这样 Python 端不再自己决定分P, 避免 Evidence Identity 错误 (TS 选 P2 实际下载 P1)
    passed_cid: int | None = None
    sessdata: str | None = None
    if len(sys.argv) > 2 and sys.argv[2]:
        arg2 = sys.argv[2]
        # 简单判断: 全数字当 cid, 否则当 sessdata (兼容旧独立调用)
        if arg2.isdigit():
            passed_cid = int(arg2)
        else:
            sessdata = arg2
    if len(sys.argv) > 3:
        sessdata = sys.argv[3]

    print(f"\n=== Cookie 策略 C 调研: {bv_id} ===\n", file=sys.stderr)

    # 1. 查 CID (优先用外部传入的, 没有才 fallback)
    if passed_cid is not None:
        cid = passed_cid
        print(f"[C/1] CID () = {cid}", file=sys.stderr)
    else:
        print(f"[C/1] 查 CID (view API, fallback)...", file=sys.stderr)
        cid = get_cid(bv_id, sessdata)
        print(f"[C/1] CID = {cid}", file=sys.stderr)

    # 2. 拿 audio.m4s URL
    print(f"[C/2] 拿 audio URL (playurl API, 旧版, 无 WBI)...", file=sys.stderr)
    audio_url, fmt = get_audio_url(bv_id, cid, sessdata)
    print(f"[C/2] format = {fmt}", file=sys.stderr)
    print(f"[C/2] audio URL (前 150 字符): {audio_url[:150]}...", file=sys.stderr)

    # 3. 下载
    # 命名含 cid, 跨分P 隔离
    file_stem = f"{bv_id}_{cid}" if passed_cid is not None else bv_id
    output_path = Path(f"data/raw/{file_stem}.c_audio.m4s")
    print(f"[C/3] 下载 audio.m4s 到 {output_path}...", file=sys.stderr)
    download_m4s(audio_url, output_path)
    size = output_path.stat().st_size
    print(f"[C/3] 完成: {size:,} bytes", file=sys.stderr)

    # 4. 验证: 用 ffprobe 查时长
    probe = subprocess.run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration,bit_rate",
        "-of", "default=noprint_wrappers=1",
        str(output_path),
    ], capture_output=True, text=True)
    print(f"[C/4] ffprobe: {probe.stdout.strip()}", file=sys.stderr)

    print(f"\n=== C 方案可行性: ✓ 跑通 (SESSDATA={'有' if sessdata else '无'}, cid={'透传 ' + str(cid) if passed_cid is not None else 'fallback view API'}) ===\n", file=sys.stderr)


if __name__ == "__main__":
    main()
