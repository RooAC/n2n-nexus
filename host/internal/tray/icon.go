package tray

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"math"
	"runtime"
)

// iconPNG draws the tray icon at size×size: a filled teal disc with two white
// nodes joined by a line (two conversations linked through the host).
func iconPNG(size int) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	teal := color.NRGBA{R: 0x14, G: 0x8f, B: 0x8a, A: 0xff}
	white := color.NRGBA{R: 0xff, G: 0xff, B: 0xff, A: 0xff}
	s := float64(size)
	c, r := s/2, s/2-0.5
	ax, ay, bx, by := s*0.32, s*0.66, s*0.68, s*0.34
	node := s * 0.13
	line := s * 0.06
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			px, py := float64(x)+0.5, float64(y)+0.5
			if math.Hypot(px-c, py-c) > r {
				continue
			}
			img.SetNRGBA(x, y, teal)
			if math.Hypot(px-ax, py-ay) <= node || math.Hypot(px-bx, py-by) <= node || segmentDist(px, py, ax, ay, bx, by) <= line {
				img.SetNRGBA(x, y, white)
			}
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func segmentDist(px, py, ax, ay, bx, by float64) float64 {
	dx, dy := bx-ax, by-ay
	t := ((px-ax)*dx + (py-ay)*dy) / (dx*dx + dy*dy)
	t = math.Max(0, math.Min(1, t))
	return math.Hypot(px-(ax+t*dx), py-(ay+t*dy))
}

// iconICO is a Windows .ico holding the 16 and 32 px icons as PNG images.
func iconICO() []byte {
	sizes := []int{16, 32}
	images := make([][]byte, len(sizes))
	for i, s := range sizes {
		images[i] = iconPNG(s)
	}
	var buf bytes.Buffer
	_ = binary.Write(&buf, binary.LittleEndian, [3]uint16{0, 1, uint16(len(sizes))}) // reserved, type icon, count
	offset := 6 + 16*len(sizes)
	for i, s := range sizes {
		entry := struct {
			W, H, Colors, Reserved uint8
			Planes, BPP            uint16
			Size, Offset           uint32
		}{uint8(s), uint8(s), 0, 0, 1, 32, uint32(len(images[i])), uint32(offset)}
		_ = binary.Write(&buf, binary.LittleEndian, entry)
		offset += len(images[i])
	}
	for _, img := range images {
		buf.Write(img)
	}
	return buf.Bytes()
}

// trayIcon is the icon in the format systray takes on this platform.
func trayIcon() []byte {
	if runtime.GOOS == "windows" {
		return iconICO()
	}
	return iconPNG(32)
}
