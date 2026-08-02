#!/usr/bin/env python3
"""Generate compact, adversarial PDF fixtures for the local PDF eval.

The PDFs intentionally consist of rasterized pages. That lets the paired eval
send the identical page pixels as images without depending on a system PDF
renderer, while the raw condition still follows PwrAgent's real file-reference
path and asks Codex to inspect a PDF on disk.

Requires Pillow, which is intentionally not a product dependency. The generated
PDFs and page PNGs are checked in so running the live eval needs no Python.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


WIDTH = 918
HEIGHT = 1188
MARGIN = 54
GUTTER = 30
COLUMN_WIDTH = (WIDTH - (MARGIN * 2) - GUTTER) // 2
LEFT = MARGIN
RIGHT = MARGIN + COLUMN_WIDTH + GUTTER

INK = "#1b2430"
MUTED = "#52606d"
PAPER = "#fcfbf7"
RULE = "#b8c2cc"
BLUE = "#245c85"
ORANGE = "#c9652c"
GREEN = "#4b7653"


def get_font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont:
    names = (
        ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf"]
        if bold
        else ["/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf"]
    )
    for name in names:
        if Path(name).exists():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default()


def page() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGB", (WIDTH, HEIGHT), PAPER)
    return image, ImageDraw.Draw(image)


def text(draw: ImageDraw.ImageDraw, xy: tuple[int, int], value: str, size: int, *, bold: bool = False, fill: str = INK, **kwargs: object) -> None:
    draw.text(xy, value, font=get_font(size, bold=bold), fill=fill, **kwargs)


def multiline(draw: ImageDraw.ImageDraw, xy: tuple[int, int], value: str, size: int, *, bold: bool = False, fill: str = INK, spacing: int = 7) -> None:
    draw.multiline_text(xy, value, font=get_font(size, bold=bold), fill=fill, spacing=spacing)


def rule(draw: ImageDraw.ImageDraw, y: int) -> None:
    draw.line((MARGIN, y, WIDTH - MARGIN, y), fill=RULE, width=2)


def header(draw: ImageDraw.ImageDraw, title: str, page_number: int) -> None:
    text(draw, (MARGIN, 34), title, 17, bold=True, fill=BLUE)
    page_label = f"PAGE {page_number}"
    page_font = get_font(15, bold=True)
    page_left = WIDTH - MARGIN - int(draw.textlength(page_label, font=page_font))
    draw.text((page_left, 34), page_label, font=page_font, fill=MUTED)
    rule(draw, 67)


def byline(draw: ImageDraw.ImageDraw, x: int, y: int, value: str) -> None:
    text(draw, (x, y), value.upper(), 14, bold=True, fill=ORANGE)


def cat_clipart(draw: ImageDraw.ImageDraw, x: int, y: int) -> None:
    draw.ellipse((x + 20, y + 34, x + 148, y + 162), fill="#d8a45d", outline=INK, width=3)
    draw.polygon(((x + 34, y + 58), (x + 50, y + 9), (x + 78, y + 52)), fill="#d8a45d", outline=INK)
    draw.polygon(((x + 108, y + 52), (x + 136, y + 9), (x + 145, y + 64)), fill="#d8a45d", outline=INK)
    draw.ellipse((x + 53, y + 79, x + 66, y + 92), fill=INK)
    draw.ellipse((x + 104, y + 79, x + 117, y + 92), fill=INK)
    draw.polygon(((x + 83, y + 104), (x + 96, y + 104), (x + 89, y + 113)), fill=ORANGE)
    for offset in (0, 12, 24):
        draw.line((x + 80, y + 113 + offset, x + 22, y + 104 + offset), fill=INK, width=2)
        draw.line((x + 98, y + 113 + offset, x + 156, y + 104 + offset), fill=INK, width=2)


def lantern_clipart(draw: ImageDraw.ImageDraw, x: int, y: int) -> None:
    draw.arc((x + 28, y, x + 112, y + 76), 180, 360, fill=INK, width=5)
    draw.rounded_rectangle((x + 17, y + 53, x + 123, y + 181), radius=12, fill="#e5bd50", outline=INK, width=4)
    draw.rectangle((x + 36, y + 77, x + 104, y + 151), fill="#fff1a6", outline=INK, width=3)
    draw.rectangle((x, y + 177, x + 140, y + 194), fill=INK)


def roadster_clipart(draw: ImageDraw.ImageDraw, x: int, y: int) -> None:
    draw.rounded_rectangle((x + 10, y + 57, x + 294, y + 142), radius=26, fill="#c84e42", outline=INK, width=4)
    draw.polygon(((x + 72, y + 58), (x + 121, y + 17), (x + 214, y + 17), (x + 252, y + 58)), fill="#cf6357", outline=INK)
    draw.polygon(((x + 130, y + 25), (x + 174, y + 25), (x + 204, y + 55), (x + 102, y + 55)), fill="#9ec7d6", outline=INK)
    for wheel_x in (x + 68, x + 235):
        draw.ellipse((wheel_x - 28, y + 111, wheel_x + 28, y + 167), fill=INK)
        draw.ellipse((wheel_x - 13, y + 126, wheel_x + 13, y + 152), fill="#e8eced")


def save_fixture(output: Path, stem: str, pages: list[Image.Image]) -> None:
    for index, image in enumerate(pages, start=1):
        image.save(output / f"{stem}-page-{index}.png", optimize=True)
    pages[0].save(
        output / f"{stem}.pdf",
        "PDF",
        save_all=True,
        append_images=pages[1:],
        resolution=110.0,
        quality=82,
    )


def harbor_gazette() -> list[Image.Image]:
    pages: list[Image.Image] = []

    image, draw = page()
    header(draw, "HARBOR GAZETTE  |  WEEKEND EDITION", 1)
    byline(draw, LEFT, 96, "City desk")
    multiline(draw, (LEFT, 126), "I LIKE CATS,\nNOT DOGS", 34, bold=True, spacing=0)
    rule(draw, 212)
    multiline(
        draw,
        (LEFT, 235),
        "THE QUIET CHOICE IS A WINDOW LEDGE.\n\n"
        "On the east pier, the morning starts\nwith gulls, coffee, and the sound\n"
        "of a key turning in a shop door.\nThe harbor is ordinary only until\nsomeone pays attention.",
        20,
    )
    cat_clipart(draw, LEFT + 88, 480)
    multiline(draw, (LEFT, 700), "ILLUSTRATION: a patient observer\nwaits for the sun to cross the sill.", 16, fill=MUTED)
    byline(draw, RIGHT, 96, "River notes")
    multiline(draw, (RIGHT, 126), "THE LONG WAY\nHOME", 30, bold=True, spacing=0)
    rule(draw, 202)
    multiline(
        draw,
        (RIGHT, 225),
        "A ferry operator keeps a folded map\nunder the radio. The last crossing\n"
        "leaves when the river turns copper.\n\n"
        "The document's first fact belongs\ndirectly below its own heading, not\nin the neighboring column.",
        20,
    )
    lantern_clipart(draw, RIGHT + 106, 530)
    pages.append(image)

    image, draw = page()
    header(draw, "HARBOR GAZETTE  |  WEEKEND EDITION", 2)
    byline(draw, LEFT, 96, "Archive insert")
    multiline(draw, (LEFT, 126), "FIELD NOTES", 31, bold=True)
    rule(draw, 202)
    multiline(
        draw,
        (LEFT, 230),
        "SABLE-14\nA marker found under the old ticket booth.\n\n"
        "MORROW-62\nA tide notation entered after first light.\n\n"
        "VIOLET-08\nA receipt folded into the weather log.",
        21,
    )
    draw.rounded_rectangle((LEFT, 610, LEFT + COLUMN_WIDTH, 849), radius=12, outline=BLUE, width=3, fill="#e8f0f4")
    multiline(draw, (LEFT + 24, 637), "COLUMN ONE\nThese three codes are ordered\nfrom top to bottom.", 21, bold=True, fill=BLUE)
    byline(draw, RIGHT, 96, "Advertisement")
    multiline(draw, (RIGHT, 126), "KEEP YOUR\nLANTERN LIT", 31, bold=True, spacing=0)
    rule(draw, 202)
    multiline(
        draw,
        (RIGHT, 230),
        "CANARY-91\nReplacement wicks, packed by noon.\n\n"
        "JUNIPER-31\nBrass polish for storm-worn handles.\n\n"
        "EMBER-77\nA spare globe for the next crossing.",
        21,
    )
    lantern_clipart(draw, RIGHT + 110, 600)
    pages.append(image)

    image, draw = page()
    header(draw, "HARBOR GAZETTE  |  WEEKEND EDITION", 3)
    byline(draw, LEFT, 96, "Museum desk")
    multiline(draw, (LEFT, 126), "THE LOST\nARCHIVE", 32, bold=True, spacing=0)
    rule(draw, 202)
    multiline(
        draw,
        (LEFT, 230),
        "A blue notice was discovered behind\na framed shipping schedule. Its\n"
        "lettering has not been transcribed\ninto the article.",
        20,
    )
    notice = Image.new("RGB", (620, 350), "#245c85")
    notice_draw = ImageDraw.Draw(notice)
    notice_draw.rounded_rectangle((14, 14, 606, 336), radius=20, outline="#d9edf8", width=5)
    notice_draw.text((42, 54), "IMAGE-ONLY NOTICE", font=get_font(31, bold=True), fill="#d9edf8")
    notice_draw.line((42, 112, 575, 112), fill="#d9edf8", width=3)
    notice_draw.text((42, 150), "FILING CODE", font=get_font(26, bold=True), fill="#c6dbe7")
    notice_draw.text((42, 202), "ORCHID-47", font=get_font(55, bold=True), fill="white")
    notice_draw.text((42, 277), "retain with the harbor maps", font=get_font(22), fill="#d9edf8")
    image.paste(notice, (148, 520))
    multiline(
        draw,
        (RIGHT, 230),
        "CLIP FILE\n\nA curator reports the notice has a\nblue field and a single filing code.\n"
        "The small type is a handling\ninstruction.",
        20,
    )
    cat_clipart(draw, RIGHT + 96, 540)
    pages.append(image)
    return pages


def roadster_record() -> list[Image.Image]:
    pages: list[Image.Image] = []

    image, draw = page()
    header(draw, "2026 PIONEER ROADSTER  |  CUSTOMER EQUIPMENT RECORD", 1)
    byline(draw, LEFT, 96, "Base equipment")
    multiline(draw, (LEFT, 126), "STANDARD\nEQUIPMENT", 31, bold=True, spacing=0)
    rule(draw, 202)
    multiline(
        draw,
        (LEFT, 230),
        "RF1  SOFT TOP\nStandard delivery roof.\n\n"
        "ST4  TOURING SEATS\nStandard trim package.\n\n"
        "WH2  ALLOY WHEELS\nStandard wheel package.\n\n"
        "Apply changes in printed order\nbefore deciding delivered equipment.",
        20,
    )
    byline(draw, RIGHT, 96, "Selected options")
    multiline(draw, (RIGHT, 126), "ORDERED\nCHANGES", 31, bold=True, spacing=0)
    rule(draw, 202)
    multiline(
        draw,
        (RIGHT, 230),
        "XZ1  ADD HARD TOP\nSelected roof conversion.\nReplaces the Soft Top.\n\n"
        "PK8  WINTER MAT SET\nAccessory package.\n\n"
        "SP3  WIND DEFLECTOR\nAccessory package.",
        20,
    )
    roadster_clipart(draw, RIGHT + 36, 620)
    pages.append(image)

    image, draw = page()
    header(draw, "2026 PIONEER ROADSTER  |  CUSTOMER EQUIPMENT RECORD", 2)
    byline(draw, LEFT, 96, "Continuation")
    multiline(draw, (LEFT, 126), "ROOF\nAPPLICATION", 31, bold=True, spacing=0)
    rule(draw, 202)
    multiline(
        draw,
        (LEFT, 230),
        "RF1  SOFT TOP (DELETE)\nDeleted by the selected XZ1 roof conversion.\n\n"
        "This deletion removes the\nbase-equipment Soft Top. It does\nnot remove the replacement\nHard Top.",
        20,
    )
    byline(draw, RIGHT, 96, "Other details")
    multiline(draw, (RIGHT, 126), "DELIVERY\nACCESSORIES", 31, bold=True, spacing=0)
    rule(draw, 202)
    multiline(
        draw,
        (RIGHT, 230),
        "BK4  CARGO NET\nIncluded with the winter mat set.\n\n"
        "CR2  CHARGE CABLE\nIncluded with roadside kit.\n\n"
        "These accessories do not\nestablish a roof condition.",
        20,
    )
    roadster_clipart(draw, LEFT + 40, 650)
    pages.append(image)

    image, draw = page()
    header(draw, "2026 PIONEER ROADSTER  |  CUSTOMER EQUIPMENT RECORD", 3)
    byline(draw, LEFT, 96, "Delivery worksheet")
    multiline(draw, (LEFT, 126), "READING\nORDER", 31, bold=True, spacing=0)
    rule(draw, 202)
    multiline(
        draw,
        (LEFT, 230),
        "For equipment state, apply each\nrule in printed order:\n"
        "1. top to bottom in the left column;\n"
        "2. then top to bottom in the right;\n"
        "3. then continue on the next page.\n\n"
        "Do not treat a keyword match\nas final delivery configuration.",
        20,
    )
    byline(draw, RIGHT, 96, "Final inspection")
    multiline(draw, (RIGHT, 126), "HANDOFF\nCHECKLIST", 31, bold=True, spacing=0)
    rule(draw, 202)
    multiline(
        draw,
        (RIGHT, 230),
        "Keys: 2\nManuals: 1\nFloor mats: installed\nRoof storage bag: omitted\n\n"
        "The worksheet records\napplication rules, not a\none-line roof answer.",
        20,
    )
    roadster_clipart(draw, RIGHT + 30, 610)
    pages.append(image)
    return pages


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(__file__).parent)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    save_fixture(output, "harbor-gazette", harbor_gazette())
    save_fixture(output, "roadster-equipment-record", roadster_record())
    print(f"wrote PDF eval fixtures to {output}")


if __name__ == "__main__":
    main()
