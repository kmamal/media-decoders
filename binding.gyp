{
    'variables': {
        'werror%': 0,
    },
    'targets': [
        {
            'target_name': 'media_decoders',
            'sources': [
                'src/native/module.cpp',
                'src/native/byte-source.cpp',
                'src/native/file-core.cpp',
                'src/native/file-binding.cpp',
                'src/native/codec.cpp',
                'src/native/track.cpp',
                'src/native/video-track.cpp',
                'src/native/audio-track.cpp',
                'src/native/silent-track.cpp',
                'src/native/audio-pipeline.cpp',
                'src/native/video-output.cpp',
                'src/native/feed-writer.cpp',
                'src/native/feed.cpp',
                'src/native/feed-reader.cpp',
                'src/native/video-feed.cpp',
                'src/native/video-feed-writer.cpp',
                'src/native/video-feed-reader.cpp',
                'src/native/media-input.cpp',
                'src/native/resampler.cpp',
                'src/native/audio-trim.cpp',
            ],
            'dependencies': [
                "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except",
            ],
            'defines': [
                # Node-API 9, which every supported Node.js (v22.16.0 and later) has
                'NAPI_VERSION=9',
                'NODE_ADDON_API_DISABLE_DEPRECATED',
                'NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS',
            ],
            'cflags': ['-Wall', '-Wextra'],
            'conditions': [
                [
                    'werror == 1', {
                        'cflags': ['-Werror'],
                        'xcode_settings': {
                            'GCC_TREAT_WARNINGS_AS_ERRORS': 'YES',
                        },
                        'msvs_settings': {
                            'VCCLCompilerTool': {
                                'WarnAsError': 'true',
                            },
                        },
                    }
                ],
                [
                    'OS == "linux" or OS == "freebsd" or OS == "openbsd" or OS == "netbsd"', {
                        'cflags_cc': ['-std=c++17'],
                        'include_dirs': ['$(FFMPEG_INC)'],
                        'libraries': [
                            '-L$(FFMPEG_LIB)',
                            '-lavformat',
                            '-lavcodec',
                            '-lswscale',
                            '-lswresample',
                            '-lavutil',
                        ],
                        'link_settings': {
                            'libraries': ["-Wl,-rpath,'$$ORIGIN'"],
                        },
                    }
                ],
                [
                    'OS == "mac"', {
                        'xcode_settings': {
                            'OTHER_CFLAGS': ['-std=c++17'],
                            'WARNING_CFLAGS': ['-Wall', '-Wextra'],
                            'MACOSX_DEPLOYMENT_TARGET': '11.0',
                        },
                        'include_dirs': ['$(FFMPEG_INC)'],
                        'libraries': [
                            '-L$(FFMPEG_LIB)',
                            '-lavformat',
                            '-lavcodec',
                            '-lswscale',
                            '-lswresample',
                            '-lavutil',
                        ],
                        'link_settings': {
                            'libraries': ['-Wl,-rpath,@loader_path'],
                        },
                    }
                ],
                [
                    'OS == "win"', {
                        'msvs_settings': {
                            'VCCLCompilerTool': {
                                'AdditionalOptions': ['-std:c++17'],
                                'WarningLevel': '4',
                                'DisableSpecificWarnings': ['4127', '4244'],
                            },
                        },
                        'include_dirs': ['<!(echo %FFMPEG_INC%)'],
                        'libraries': [
                            '-l<!(echo %FFMPEG_LIB%)\\avformat.lib',
                            '-l<!(echo %FFMPEG_LIB%)\\avcodec.lib',
                            '-l<!(echo %FFMPEG_LIB%)\\swscale.lib',
                            '-l<!(echo %FFMPEG_LIB%)\\swresample.lib',
                            '-l<!(echo %FFMPEG_LIB%)\\avutil.lib',
                        ],
                    }
                ],
            ],
        }
    ],
}
