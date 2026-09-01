# sharp / libvips — bundled native library notice

DUIN uses [sharp](https://github.com/lovell/sharp) 0.34.5 (Apache-2.0) for image
decoding and resizing. The prebuilt platform package it installs
(`@img/sharp-win32-x64`, `@img/sharp-linux-x64`, `@img/sharp-darwin-arm64`, …)
is licensed **"Apache-2.0 AND LGPL-3.0-or-later"** because it carries a
prebuilt copy of **libvips 8.17.3** and the libraries libvips depends on.

libvips ships as a separate, dynamically linked shared library
(`lib/libvips-42.dll` + `libvips-cpp-8.17.3.dll` on Windows, `libvips-cpp.so` /
`libvips-cpp.dylib` on Linux / macOS) next to the small `sharp-<platform>.node`
binding. You may replace that shared library with your own build of libvips, as
the LGPL requires. The LGPL-3.0 text is in `LGPL-3.0.txt` in this directory; it
is a set of additional permissions on top of the GPL-3.0, whose text is in
`GPL-3.0.txt`. Source for libvips and the bundled libraries:
<https://github.com/lovell/sharp-libvips> (build recipes and exact versions,
which are also listed in the package's `versions.json`).

The table below is reproduced from `node_modules/@img/sharp-win32-x64/README.md`
(sharp-libvips, Copyright 2013 Lovell Fuller and others). Versions are from the
same package's `versions.json`.

| Library       | Version  | Used under the terms of                                                                                   |
|---------------|----------|-----------------------------------------------------------------------------------------------------------|
| aom           | 3.13.1   | BSD 2-Clause + [Alliance for Open Media Patent License 1.0](https://aomedia.org/license/patent-license/)  |
| cairo         | 1.18.4   | Mozilla Public License 2.0                                                                                |
| cgif          | 0.5.0    | MIT Licence                                                                                               |
| expat         | 2.7.3    | MIT Licence                                                                                               |
| fontconfig    | 2.17.1   | [fontconfig Licence](https://gitlab.freedesktop.org/fontconfig/fontconfig/blob/main/COPYING) (BSD-like)   |
| freetype      | 2.14.1   | [freetype Licence](https://git.savannah.gnu.org/cgit/freetype/freetype2.git/tree/docs/FTL.TXT) (BSD-like) |
| fribidi       | 1.0.16   | LGPLv3                                                                                                    |
| glib          | 2.86.1   | LGPLv3                                                                                                    |
| harfbuzz      | 12.1.0   | MIT Licence                                                                                               |
| highway       | 1.3.0    | Apache-2.0 License, BSD 3-Clause                                                                          |
| lcms          | 2.17     | MIT Licence                                                                                               |
| libarchive    | 3.8.2    | BSD 2-Clause                                                                                              |
| libexif       | 0.6.25   | LGPLv3                                                                                                    |
| libffi        | 3.5.2    | MIT Licence                                                                                               |
| libheif       | 1.20.2   | LGPLv3                                                                                                    |
| libimagequant | 2.4.1    | [BSD 2-Clause](https://github.com/lovell/libimagequant/blob/main/COPYRIGHT)                               |
| libnsgif      | —        | MIT Licence                                                                                               |
| libpng        | 1.6.50   | [libpng License](https://github.com/pnggroup/libpng/blob/master/LICENSE)                                  |
| librsvg       | 2.61.2   | LGPLv3                                                                                                    |
| libspng       | 0.7.4    | [BSD 2-Clause, libpng License](https://github.com/randy408/libspng/blob/master/LICENSE)                   |
| libtiff       | 4.7.1    | [libtiff License](https://gitlab.com/libtiff/libtiff/blob/master/LICENSE.md) (BSD-like)                   |
| libvips       | 8.17.3   | LGPLv3                                                                                                    |
| libwebp       | 1.6.0    | New BSD License                                                                                           |
| libxml2       | 2.15.1   | MIT Licence                                                                                               |
| mozjpeg       | 0826579  | [zlib License, IJG License, BSD-3-Clause](https://github.com/mozilla/mozjpeg/blob/master/LICENSE.md)      |
| pango         | 1.57.0   | LGPLv3                                                                                                    |
| pixman        | 0.46.4   | MIT Licence                                                                                               |
| proxy-libintl | 0.5      | LGPLv3                                                                                                    |
| zlib-ng       | 2.2.5    | [zlib Licence](https://github.com/zlib-ng/zlib-ng/blob/develop/LICENSE.md)                                |

Use of libraries under the terms of the LGPLv3 is via the "any later version"
clause of the LGPLv2 or LGPLv2.1.

Errors or omissions in the upstream table: <https://github.com/lovell/sharp-libvips/issues/new>.
