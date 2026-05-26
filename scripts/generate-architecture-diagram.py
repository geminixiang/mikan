#!/usr/bin/env python3
"""Generate docs/assets/architecture.png.

The README uses a PNG instead of Mermaid because GitHub mobile does not
consistently render Mermaid diagrams. Keep this generator versioned so the
architecture image remains reviewable and reproducible.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "assets" / "architecture.png"

W, H = 2200, 1150
BG = "#fbfaf7"
TEXT = "#1f2937"
MUTED = "#64748b"
BORDER = "#d8dee9"
BLUE = "#dbeafe"
BLUE_BORDER = "#93c5fd"
GREEN = "#dcfce7"
GREEN_BORDER = "#86efac"
PURPLE = "#ede9fe"
PURPLE_BORDER = "#c4b5fd"
ORANGE = "#ffedd5"
ORANGE_BORDER = "#fdba74"
YELLOW = "#fef9c3"
YELLOW_BORDER = "#fde68a"
GRAY = "#f3f4f6"
GRAY_BORDER = "#d1d5db"
LINE = "#64748b"

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Helvetica.ttf",
    "/Library/Fonts/Arial.ttf",
]


def font(size: int) -> ImageFont.ImageFont:
    font_path = next((path for path in FONT_CANDIDATES if Path(path).exists()), None)
    if font_path:
        return ImageFont.truetype(font_path, size=size)
    return ImageFont.load_default()


TITLE = font(44)
SUBTITLE = font(24)
LABEL = font(25)
BODY = font(20)
SMALL = font(18)


def rounded_rect(draw: ImageDraw.ImageDraw, box, fill: str, outline: str, width=3, radius=24):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def text_center(draw: ImageDraw.ImageDraw, box, text: str, fnt=BODY, fill=TEXT, gap=6):
    lines = text.split("\n")
    heights = []
    widths = []
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=fnt)
        widths.append(bbox[2] - bbox[0])
        heights.append(bbox[3] - bbox[1])

    y = (box[1] + box[3] - sum(heights) - gap * (len(lines) - 1)) / 2
    for line, width, height in zip(lines, widths, heights):
        draw.text(((box[0] + box[2] - width) / 2, y), line, font=fnt, fill=fill)
        y += height + gap


def content_box(draw: ImageDraw.ImageDraw, x, y, w, h, title: str, items, fill: str, border: str):
    rounded_rect(draw, (x, y, x + w, y + h), fill, border)
    draw.text((x + 26, y + 22), title, font=LABEL, fill=TEXT)
    yy = y + 68
    for item in items:
        draw.text((x + 34, yy), "• " + item, font=BODY, fill=TEXT)
        yy += 34
    return (x, y, x + w, y + h)


def arrow(draw: ImageDraw.ImageDraw, p1, p2, color=LINE, width=4):
    import math

    draw.line([p1, p2], fill=color, width=width)
    angle = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
    size = 16
    points = [
        (p2[0] + size * math.cos(angle + math.pi * 0.84), p2[1] + size * math.sin(angle + math.pi * 0.84)),
        (p2[0] + size * math.cos(angle - math.pi * 0.84), p2[1] + size * math.sin(angle - math.pi * 0.84)),
    ]
    draw.polygon([p2] + points, fill=color)


def edge_label(draw: ImageDraw.ImageDraw, x, y, text: str):
    bbox = draw.textbbox((0, 0), text, font=SMALL)
    pad = 6
    draw.rounded_rectangle((x - pad, y - pad, x + bbox[2] + pad, y + bbox[3] + pad), radius=8, fill=BG)
    draw.text((x, y), text, font=SMALL, fill=MUTED)


def main():
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    draw.text((80, 55), "mikan architecture", font=TITLE, fill=TEXT)
    draw.text(
        (80, 112),
        "Chat history, structured agent sessions, and sandbox runtime are intentionally separate.",
        font=SUBTITLE,
        fill=MUTED,
    )

    platform = (80, 245, 360, 355)
    rounded_rect(draw, platform, GRAY, GRAY_BORDER, radius=28)
    text_center(draw, platform, "Slack / Discord /\nTelegram adapter")

    content_box(
        draw,
        470,
        205,
        430,
        230,
        "1. Chat / conversation data",
        ["log.jsonl platform history", "attachments/", "conversation files"],
        BLUE,
        BLUE_BORDER,
    )
    content_box(
        draw,
        470,
        500,
        430,
        280,
        "2. Session orchestration",
        ["SessionRuntime", "ConversationOrchestrator", "top-level / thread / fork", "sessions/*.jsonl context"],
        GREEN,
        GREEN_BORDER,
    )
    content_box(
        draw,
        1030,
        500,
        430,
        280,
        "pi-coding-agent harness",
        ["AgentRunner", "AgentSession", "model loop", "mikan tools"],
        PURPLE,
        PURPLE_BORDER,
    )
    content_box(
        draw,
        1610,
        500,
        470,
        280,
        "3. Sandbox runtime",
        ["Executor abstraction", "shared: host / container", "isolated: image / firecracker / cloudflare", "runtime workspace mapping"],
        ORANGE,
        ORANGE_BORDER,
    )
    content_box(
        draw,
        1610,
        205,
        470,
        230,
        "3-1. Vault",
        ["env vars", "secret files", "runtime mounts"],
        YELLOW,
        YELLOW_BORDER,
    )

    arrow(draw, (360, 300), (470, 300))
    edge_label(draw, 383, 270, "records")
    arrow(draw, (685, 435), (685, 500))
    edge_label(draw, 710, 455, "materializes / scopes")
    arrow(draw, (900, 640), (1030, 640))
    edge_label(draw, 940, 605, "runs")
    arrow(draw, (1460, 640), (1610, 640))
    edge_label(draw, 1490, 605, "executes tools in")
    arrow(draw, (1845, 435), (1845, 500))
    edge_label(draw, 1875, 455, "injects")

    draw.line([(220, 355), (220, 640), (470, 640)], fill=LINE, width=4)
    arrow(draw, (450, 640), (470, 640))

    strip = (80, 900, 2080, 1045)
    rounded_rect(draw, strip, "#ffffff", BORDER, radius=24)
    draw.text((120, 930), "Responsibility boundary", font=LABEL, fill=TEXT)
    draw.text(
        (120, 975),
        "Chat stores platform-visible history.  Session selects/forks structured context for a run.  Harness performs the model/tool loop.",
        font=SMALL,
        fill=MUTED,
    )
    draw.text(
        (120, 1008),
        "Sandbox decides where commands run and how runtime paths map.  Vault supplies sensitive env and file mounts.",
        font=SMALL,
        fill=MUTED,
    )
    draw.text(
        (80, 1080),
        "Sandbox runtime classes: shared = host/container; isolated = image/firecracker/cloudflare. Future providers can plug in behind Executor.",
        font=SMALL,
        fill=MUTED,
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, optimize=True)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
