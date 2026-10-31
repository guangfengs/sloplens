#!/usr/bin/env python3
"""生成 SlopLens 扩展图标（16/32/48/128）。

设计：深色圆角底 + 白色镜头环 + 琥珀色中心点。
镜头 = 「看」，琥珀点 = 「存疑」档位，和 popup 里的三档配色一致。

用法：
    python3 tools/make-icons.py
输出：
    sloplens/icons/icon{16,32,48,128}.png

重画时改下面的常量即可；图标是构建产物，但一并提交，
这样别人 clone 下来不用装 Pillow 也能跑。
"""

from pathlib import Path

from PIL import Image, ImageDraw

# ── 视觉常量（0–1 相对坐标，改这里就等于改设计）────────────────────────
BG = (16, 18, 24)           # 底色 #101218
FG = (237, 240, 247)        # 镜身 #EDF0F7
ACCENT = (245, 165, 36)     # 中心点 #F5A524

CORNER = 0.22               # 圆角半径
CENTER = (0.42, 0.40)       # 镜片圆心
RADIUS = 0.235              # 镜片半径
RING = 0.076                # 镜环线宽
HANDLE_FROM = 45            # 手柄起点角度（度）
HANDLE_TO = (0.855, 0.855)  # 手柄终点
HANDLE_W = 0.115            # 手柄线宽
DOT = 0.058                 # 中心点半径

SUPERSAMPLE = 8             # 超采样倍数，先画大再缩
SIZES = (16, 32, 48, 128)

OUT_DIR = Path(__file__).resolve().parent.parent / "sloplens" / "icons"


def render(size: int) -> Image.Image:
    """在 SUPERSAMPLE 倍画布上作画，再用 LANCZOS 缩到目标尺寸。"""
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def px(v: float) -> float:
        return v * s

    d.rounded_rectangle(
        [(0, 0), (s - 1, s - 1)],
        radius=px(CORNER),
        fill=BG + (255,),
    )

    cx, cy = px(CENTER[0]), px(CENTER[1])
    r = px(RADIUS)
    ring = px(RING)
    d.ellipse(
        [(cx - r, cy - r), (cx + r, cy + r)],
        outline=FG + (255,),
        width=round(ring),
    )

    # 手柄从圆环右下 45° 处伸出，两端补圆点做出圆头
    import math

    a = math.radians(HANDLE_FROM)
    x0, y0 = cx + r * math.cos(a), cy + r * math.sin(a)
    x1, y1 = px(HANDLE_TO[0]), px(HANDLE_TO[1])
    w = px(HANDLE_W)
    d.line([(x0, y0), (x1, y1)], fill=FG + (255,), width=round(w))
    for x, y in ((x0, y0), (x1, y1)):
        d.ellipse([(x - w / 2, y - w / 2), (x + w / 2, y + w / 2)], fill=FG + (255,))

    # 镜片中心点：代表「存疑」，不是判决
    dr = px(DOT)
    d.ellipse([(cx - dr, cy - dr), (cx + dr, cy + dr)], fill=ACCENT + (255,))

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT_DIR / f"icon{size}.png"
        render(size).save(path, optimize=True)
        print(f"{path.relative_to(OUT_DIR.parent.parent)}  {size}x{size}  "
              f"{path.stat().st_size} B")


if __name__ == "__main__":
    main()
