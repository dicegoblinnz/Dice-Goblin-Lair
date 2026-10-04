"""Decode every QR code in a screenshot and print them as a Python list, e.g. ['SJ-OWLBEAR-17'].

Used by the round 5 checks (mg4/bill.mjs, mg4/games.mjs). Needs: pip install zxing-cpp pillow
(on the Claude cloud container add --break-system-packages). Falls back to OpenCV when zxing-cpp is missing.
"""
import sys

from PIL import Image


def decode(path):
    image = Image.open(path).convert("RGB")
    try:
        import zxingcpp

        return [r.text for r in zxingcpp.read_barcodes(image)]
    except ImportError:
        import cv2
        import numpy as np

        detector = cv2.QRCodeDetector()
        ok, texts, _, _ = detector.detectAndDecodeMulti(np.array(image)[:, :, ::-1])
        return [t for t in texts if t] if ok else []


if __name__ == "__main__":
    print(decode(sys.argv[1]))
