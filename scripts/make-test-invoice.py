#!/usr/bin/env python3
"""
Makes supplier invoices for testing invoice intake (docs/invoice-intake.md):

  <invoice>.pdf        a PDF with a text layer, read locally by outlook_readAttachment
  <invoice>-scan.png   the same invoice as a scanned image, read by SAP Document AI
  <invoice>-scan.pdf   the scan as an image-only PDF (no text layer), also read by SAP Document AI

Mail the files to the AP clerk's Outlook inbox and ask the Invoice intake agent to post them.
The defaults match mock purchase order 4500012410 (Gulf Industrial Supplies, 40 EA delivered).
For a real S/4HANA system, pass a purchase order of yours whose goods are received:

  pip install reportlab pillow
  python scripts/make-test-invoice.py --po 4500001234 --supplier "Supplier Name" \
      --invoice INV-1001 --line "Item description|10|EA|125.00" --tax-rate 15 --currency SAR

All companies, addresses and bank details on the invoices are fictitious.
"""
import argparse
import datetime as dt
import os
import random
from decimal import ROUND_HALF_UP, Decimal

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

FONTS = os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts")


def money(v: Decimal) -> str:
    return f"{v.quantize(Decimal('0.01'), ROUND_HALF_UP):,.2f}"


def build(args):
    lines = []
    for raw in args.line or ["Pump mechanical seal kit|40|EA|4250.00"]:
        desc, qty, unit, price = raw.split("|")
        q, p = Decimal(qty), Decimal(price)
        lines.append({"desc": desc, "qty": q, "unit": unit, "price": p, "amount": (q * p).quantize(Decimal("0.01"), ROUND_HALF_UP)})
    net = sum((l["amount"] for l in lines), Decimal(0))
    tax = (net * Decimal(str(args.tax_rate)) / 100).quantize(Decimal("0.01"), ROUND_HALF_UP)
    date = dt.date.fromisoformat(args.date)
    return {
        "lines": lines,
        "net": net,
        "tax": tax,
        "gross": net + tax,
        "date": date,
        "due": date + dt.timedelta(days=30),
    }


def header_rows(args, inv):
    return [
        ("Invoice number", args.invoice),
        ("Invoice date", inv["date"].isoformat()),
        ("Your purchase order", args.po),
        ("Due date", inv["due"].isoformat()),
        ("Payment terms", "30 days net"),
    ]


def write_pdf(path, args, inv):
    c = canvas.Canvas(path, pagesize=A4)
    w, h = A4
    c.setTitle(f"Invoice {args.invoice}")
    c.setAuthor(args.supplier)

    # Supplier block
    c.setFillColor(colors.HexColor("#0b5394"))
    c.rect(0, h - 28 * mm, w, 28 * mm, stroke=0, fill=1)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(20 * mm, h - 15 * mm, args.supplier)
    c.setFont("Helvetica", 9)
    c.drawString(20 * mm, h - 21 * mm, f"{args.supplier_address}  |  VAT reg. {args.vat_id}")

    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(20 * mm, h - 42 * mm, "TAX INVOICE")

    # Bill-to and invoice facts
    c.setFont("Helvetica-Bold", 9)
    c.drawString(20 * mm, h - 54 * mm, "Bill to")
    c.setFont("Helvetica", 9)
    for i, t in enumerate(args.bill_to.split("|")):
        c.drawString(20 * mm, h - (59 + i * 4.5) * mm, t)
    for i, (k, v) in enumerate(header_rows(args, inv)):
        c.setFont("Helvetica-Bold", 9)
        c.drawString(115 * mm, h - (54 + i * 5) * mm, f"{k}:")
        c.setFont("Helvetica", 9)
        c.drawString(150 * mm, h - (54 + i * 5) * mm, v)

    # Items
    y = h - 92 * mm
    cols = [20, 30, 110, 130, 145, 170]
    c.setFillColor(colors.HexColor("#eeeeee"))
    c.rect(18 * mm, y - 2 * mm, w - 36 * mm, 7 * mm, stroke=0, fill=1)
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 9)
    for x, t in zip(cols, ["Item", "Description", "Qty", "Unit", "Unit price", "Amount"]):
        c.drawString(x * mm, y, t)
    c.setFont("Helvetica", 9)
    for n, l in enumerate(inv["lines"], start=1):
        y -= 7 * mm
        c.drawString(cols[0] * mm, y, str(n * 10))
        c.drawString(cols[1] * mm, y, l["desc"][:45])
        c.drawRightString((cols[2] + 12) * mm, y, f"{l['qty']:,}")
        c.drawString(cols[3] * mm, y, l["unit"])
        c.drawRightString((cols[4] + 20) * mm, y, money(l["price"]))
        c.drawRightString((cols[5] + 20) * mm, y, money(l["amount"]))
    c.line(18 * mm, y - 4 * mm, w - 18 * mm, y - 4 * mm)

    # Totals
    y -= 12 * mm
    for label, value, bold in [
        ("Net amount", inv["net"], False),
        (f"VAT {args.tax_rate:g}%", inv["tax"], False),
        ("Total amount due", inv["gross"], True),
    ]:
        c.setFont("Helvetica-Bold" if bold else "Helvetica", 10 if bold else 9)
        c.drawString(130 * mm, y, label)
        c.drawRightString(190 * mm, y, f"{args.currency} {money(value)}")
        y -= 6 * mm

    # Bank details
    c.setFont("Helvetica-Bold", 9)
    c.drawString(20 * mm, 40 * mm, "Bank details")
    c.setFont("Helvetica", 9)
    c.drawString(20 * mm, 35 * mm, f"{args.bank}  |  IBAN {args.iban}")
    c.drawString(20 * mm, 30 * mm, f"Please quote invoice {args.invoice} and purchase order {args.po} with your payment.")
    c.setFont("Helvetica-Oblique", 7)
    c.setFillColor(colors.grey)
    c.drawString(20 * mm, 15 * mm, "Test document for invoice intake. All parties and bank details are fictitious.")
    c.showPage()
    c.save()


def font(size, bold=False, mono=False):
    name = ("consolab.ttf" if bold else "consola.ttf") if mono else ("arialbd.ttf" if bold else "arial.ttf")
    try:
        return ImageFont.truetype(os.path.join(FONTS, name), size)
    except OSError:
        return ImageFont.load_default(size)


def write_scan(png_path, pdf_path, args, inv, seed=7):
    """The invoice as a 200 dpi greyscale scan: slightly rotated, with paper noise and a soft blur."""
    dpi = 200
    W, H = int(8.27 * dpi), int(11.69 * dpi)
    img = Image.new("L", (W, H), 250)
    d = ImageDraw.Draw(img)
    px = lambda v_mm: int(v_mm / 25.4 * dpi)  # noqa: E731

    d.text((px(20), px(12)), args.supplier, font=font(px(7), bold=True), fill=20)
    d.text((px(20), px(21)), f"{args.supplier_address}  |  VAT reg. {args.vat_id}", font=font(px(3.2)), fill=40)
    d.line((px(20), px(27), W - px(20), px(27)), fill=60, width=3)
    d.text((px(20), px(34)), "TAX INVOICE", font=font(px(6), bold=True), fill=15)

    d.text((px(20), px(48)), "Bill to", font=font(px(3.4), bold=True), fill=20)
    for i, t in enumerate(args.bill_to.split("|")):
        d.text((px(20), px(53 + i * 5)), t, font=font(px(3.4)), fill=30)
    for i, (k, v) in enumerate(header_rows(args, inv)):
        d.text((px(112), px(48 + i * 5.5)), f"{k}:", font=font(px(3.4), bold=True), fill=20)
        d.text((px(152), px(48 + i * 5.5)), v, font=font(px(3.4)), fill=30)

    y = px(88)
    cols = [20, 32, 108, 126, 142, 168]
    for x, t in zip(cols, ["Item", "Description", "Qty", "Unit", "Unit price", "Amount"]):
        d.text((px(x), y), t, font=font(px(3.4), bold=True), fill=20)
    d.line((px(20), y + px(6), W - px(20), y + px(6)), fill=80, width=2)
    for n, l in enumerate(inv["lines"], start=1):
        y += px(8)
        row = [str(n * 10), l["desc"][:40], f"{l['qty']:,}", l["unit"], money(l["price"]), money(l["amount"])]
        for x, t in zip(cols, row):
            d.text((px(x), y), t, font=font(px(3.4)), fill=30)
    y += px(10)
    d.line((px(20), y, W - px(20), y), fill=80, width=2)
    y += px(5)
    for label, value, bold in [("Net amount", inv["net"], False), (f"VAT {args.tax_rate:g}%", inv["tax"], False), ("Total amount due", inv["gross"], True)]:
        d.text((px(120), y), label, font=font(px(3.8), bold=bold), fill=15)
        d.text((px(160), y), f"{args.currency} {money(value)}", font=font(px(3.8), bold=bold), fill=15)
        y += px(7)

    d.text((px(20), H - px(48)), "Bank details", font=font(px(3.4), bold=True), fill=20)
    d.text((px(20), H - px(42)), f"{args.bank}  |  IBAN {args.iban}", font=font(px(3.4)), fill=30)
    d.text((px(20), H - px(36)), f"Please quote invoice {args.invoice} and purchase order {args.po} with your payment.", font=font(px(3.2)), fill=30)
    d.text((px(20), H - px(20)), "Test document for invoice intake. All parties and bank details are fictitious.", font=font(px(2.6)), fill=110)

    # A rubber stamp and a signature-like scribble, as on a real paper invoice.
    d.ellipse((W - px(70), H - px(80), W - px(30), H - px(52)), outline=90, width=4)
    d.text((W - px(64), H - px(70)), "RECEIVED", font=font(px(4), bold=True), fill=90)

    rnd = random.Random(seed)
    img = img.rotate(0.7, resample=Image.BICUBIC, expand=False, fillcolor=245)
    noise = Image.effect_noise((W, H), 18).point(lambda v: v - 128)
    img = Image.eval(Image.blend(img, noise.convert("L"), 0.04), lambda v: max(0, min(255, v)))
    for _ in range(400):  # dust
        x, y0 = rnd.randrange(W), rnd.randrange(H)
        d2 = ImageDraw.Draw(img)
        d2.point((x, y0), fill=rnd.randrange(60, 160))
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    img.save(png_path, dpi=(dpi, dpi), optimize=True)
    img.convert("RGB").save(pdf_path, "PDF", resolution=dpi)


def main():
    p = argparse.ArgumentParser(description="Make test supplier invoices for invoice intake.")
    p.add_argument("--supplier", default="Gulf Industrial Supplies")
    p.add_argument("--supplier-address", default="Sheikh Zayed Road 44, Dubai, UAE")
    p.add_argument("--vat-id", default="100234567800003")
    p.add_argument("--bill-to", default="Prowess Industries, Accounts Payable|King Fahd Road 101|Riyadh, Saudi Arabia")
    p.add_argument("--invoice", default="GIS-2026-0815")
    p.add_argument("--date", default="2026-10-14", help="Invoice date, YYYY-MM-DD")
    p.add_argument("--po", default="4500012410", help="Purchase order number in S/4HANA")
    p.add_argument("--currency", default="SAR")
    p.add_argument("--tax-rate", type=float, default=12, help="VAT percent")
    p.add_argument("--line", action="append", help='"description|quantity|unit|unit price", repeatable')
    p.add_argument("--bank", default="Test Bank PJSC")
    p.add_argument("--iban", default="AE07 0331 2345 6789 0123 456")
    p.add_argument("--out", default=os.path.join("test-data", "invoices"))
    p.add_argument("--no-scan", action="store_true", help="Only the text PDF")
    args = p.parse_args()

    os.makedirs(args.out, exist_ok=True)
    inv = build(args)
    base = os.path.join(args.out, args.invoice)
    write_pdf(f"{base}.pdf", args, inv)
    made = [f"{base}.pdf"]
    if not args.no_scan:
        write_scan(f"{base}-scan.png", f"{base}-scan.pdf", args, inv)
        made += [f"{base}-scan.png", f"{base}-scan.pdf"]
    print(f"Invoice {args.invoice}: PO {args.po}, net {money(inv['net'])}, VAT {money(inv['tax'])}, total {args.currency} {money(inv['gross'])}")
    for m in made:
        print("  ", m)


if __name__ == "__main__":
    main()
