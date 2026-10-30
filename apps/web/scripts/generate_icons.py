"""Regenerate the simple code-native AVC PWA icons with Pillow."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

public = Path(__file__).resolve().parents[1] / "public"

for size in (192, 512):
    image = Image.new("RGB", (size, size), "#00a1f2")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=size // 5, fill="#00a1f2")
    font = ImageFont.load_default(size=size // 4)
    draw.text((size // 2, size // 2), "AVC", font=font, anchor="mm", fill="white")
    image.save(public / f"icon-{size}.png")
