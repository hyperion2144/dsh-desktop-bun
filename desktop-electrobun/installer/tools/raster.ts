/**
 * 像素画布：RGBA8（非预乘）+ 面积平均缩放 + alpha 合成。
 *
 * 安装程序品牌图是从 `resources/app-icon.ico` 里的 PNG 图案合成出来的，而本仓运行时零依赖，
 * 不值得为一次性的资源生成引图像库——这里只实现生成品牌图真正需要的那几件事：
 * 铺底色、把一个方形图案按目标框缩放贴上去（贴纸/缩图都用面积平均，边缘不会走样）。
 */

export type Raster = {
  width: number
  height: number
  /** 逐像素 RGBA，长度 = width * height * 4，非预乘。 */
  rgba: Uint8Array
}

export type Rgb = { r: number; g: number; b: number }

/** 目标框（目标画布坐标系）。 */
export type Box = { x: number; y: number; width: number; height: number }

export function createRaster(width: number, height: number, background: Rgb): Raster {
  const rgba = new Uint8Array(width * height * 4)
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = background.r
    rgba[offset + 1] = background.g
    rgba[offset + 2] = background.b
    rgba[offset + 3] = 255
  }
  return { width, height, rgba }
}

export function pixelAt(raster: Raster, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const offset = (y * raster.width + x) * 4
  return {
    r: raster.rgba[offset] ?? 0,
    g: raster.rgba[offset + 1] ?? 0,
    b: raster.rgba[offset + 2] ?? 0,
    a: raster.rgba[offset + 3] ?? 0,
  }
}

/** 源矩形 [x0,x1)×[y0,y1) 的面积平均（按 alpha 预乘加权，跨透明度平均才不会发黑）。 */
function sampleArea(source: Raster, x0: number, y0: number, x1: number, y1: number) {
  const left = Math.max(0, x0)
  const top = Math.max(0, y0)
  const right = Math.min(source.width, x1)
  const bottom = Math.min(source.height, y1)
  if (right <= left || bottom <= top) return { r: 0, g: 0, b: 0, a: 0 }

  let sumWeight = 0
  let sumAlpha = 0
  let sumRed = 0
  let sumGreen = 0
  let sumBlue = 0
  for (let y = Math.floor(top); y < Math.ceil(bottom); y++) {
    const coverY = Math.min(y + 1, bottom) - Math.max(y, top)
    if (coverY <= 0) continue
    for (let x = Math.floor(left); x < Math.ceil(right); x++) {
      const coverX = Math.min(x + 1, right) - Math.max(x, left)
      if (coverX <= 0) continue
      const weight = coverX * coverY
      const pixel = pixelAt(source, x, y)
      const alpha = pixel.a / 255
      sumWeight += weight
      sumAlpha += alpha * weight
      sumRed += pixel.r * alpha * weight
      sumGreen += pixel.g * alpha * weight
      sumBlue += pixel.b * alpha * weight
    }
  }
  if (sumWeight === 0) return { r: 0, g: 0, b: 0, a: 0 }
  return {
    r: sumRed / sumWeight,
    g: sumGreen / sumWeight,
    b: sumBlue / sumWeight,
    a: sumAlpha / sumWeight,
  }
}

/** 把 source 缩放贴进 target 的 box（源整幅覆盖 box）；越界部分裁掉，不做环绕。 */
export function drawScaled(source: Raster, target: Raster, box: Box): void {
  const scaleX = source.width / box.width
  const scaleY = source.height / box.height
  for (let y = 0; y < box.height; y++) {
    const targetY = box.y + y
    if (targetY < 0 || targetY >= target.height) continue
    for (let x = 0; x < box.width; x++) {
      const targetX = box.x + x
      if (targetX < 0 || targetX >= target.width) continue
      const sample = sampleArea(source, x * scaleX, y * scaleY, (x + 1) * scaleX, (y + 1) * scaleY)
      const offset = (targetY * target.width + targetX) * 4
      const inverse = 1 - sample.a
      target.rgba[offset] = Math.round(sample.r + (target.rgba[offset] ?? 0) * inverse)
      target.rgba[offset + 1] = Math.round(sample.g + (target.rgba[offset + 1] ?? 0) * inverse)
      target.rgba[offset + 2] = Math.round(sample.b + (target.rgba[offset + 2] ?? 0) * inverse)
      target.rgba[offset + 3] = 255
    }
  }
}

/**
 * 圆角矩形填充：安装界面的品牌瓦片、按钮底、进度槽都用它。
 * 角上用「到圆心的距离 + 1px 羽化」算覆盖率，等于自带抗锯齿边缘。
 */
export function fillRoundedRect(target: Raster, box: Box, radius: number, color: Rgb): void {
  const limit = Math.max(0, Math.min(radius, Math.min(box.width, box.height) / 2))
  for (let y = 0; y < box.height; y++) {
    const targetY = box.y + y
    if (targetY < 0 || targetY >= target.height) continue
    for (let x = 0; x < box.width; x++) {
      const targetX = box.x + x
      if (targetX < 0 || targetX >= target.width) continue
      const centerX = Math.min(Math.max(x + 0.5, limit), box.width - limit)
      const centerY = Math.min(Math.max(y + 0.5, limit), box.height - limit)
      const dx = x + 0.5 - centerX
      const dy = y + 0.5 - centerY
      const coverage = Math.max(0, Math.min(1, limit + 0.5 - Math.sqrt(dx * dx + dy * dy)))
      if (coverage === 0) continue
      const offset = (targetY * target.width + targetX) * 4
      const inverse = 1 - coverage
      target.rgba[offset] = Math.round(color.r * coverage + (target.rgba[offset] ?? 0) * inverse)
      target.rgba[offset + 1] = Math.round(color.g * coverage + (target.rgba[offset + 1] ?? 0) * inverse)
      target.rgba[offset + 2] = Math.round(color.b * coverage + (target.rgba[offset + 2] ?? 0) * inverse)
      target.rgba[offset + 3] = 255
    }
  }
}

/**
 * 粗线段（完成页的大勾笔画）：按「像素中心到线段的距离」算覆盖，
 * 羽化口与 fillRoundedRect 一致，端点自然收圆。
 */
export function drawLineThick(target: Raster, x0: number, y0: number, x1: number, y1: number, thickness: number, color: Rgb): void {
  const half = Math.max(0.5, thickness / 2)
  const vx = x1 - x0
  const vy = y1 - y0
  const lengthSquared = vx * vx + vy * vy
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - half - 1))
  const maxX = Math.min(target.width - 1, Math.ceil(Math.max(x0, x1) + half + 1))
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - half - 1))
  const maxY = Math.min(target.height - 1, Math.ceil(Math.max(y0, y1) + half + 1))
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / lengthSquared))
      const dx = px - (x0 + vx * t)
      const dy = py - (y0 + vy * t)
      const coverage = Math.max(0, Math.min(1, half + 0.5 - Math.sqrt(dx * dx + dy * dy)))
      if (coverage === 0) continue
      const offset = (y * target.width + x) * 4
      const inverse = 1 - coverage
      target.rgba[offset] = Math.round(color.r * coverage + (target.rgba[offset] ?? 0) * inverse)
      target.rgba[offset + 1] = Math.round(color.g * coverage + (target.rgba[offset + 1] ?? 0) * inverse)
      target.rgba[offset + 2] = Math.round(color.b * coverage + (target.rgba[offset + 2] ?? 0) * inverse)
      target.rgba[offset + 3] = 255
    }
  }
}
