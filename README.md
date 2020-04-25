------------------------------------------------------------------------------------------------------------------
- SHAKA PACKAGER -
------------------------------------------------------------------------------------------------------------------

Required for creating mpd files. Will require manual linux installation in scripts folder. May not work if you create shaka_packager folder. Skip and simply run 

$ gclient config https://www.github.com/google/shaka-packager.git --name=src --unmanaged
$ gclient sync

after installing depot tools. See shaka_packager documentation

Below taken from google shaka_packager git at https://github.com/google/shaka-packager/blob/master/docs/source/build_instructions.md

Build Instructions
Shaka Packager supports building on Windows, Mac and Linux host systems.

Linux build dependencies
Most development is done on Ubuntu (currently 14.04, Trusty Tahr). The dependencies mentioned here are only for Ubuntu. There are some instructions for other distros below.

sudo apt-get update
sudo apt-get install build-essential curl git python
Note that Git must be v1.7.5 or above.

Mac system requirements
Xcode 7.3+.

The OS X 10.10 SDK or later. Run

$ ls `xcode-select -p`/Platforms/MacOSX.platform/Developer/SDKs
to check whether you have it.

Windows system requirements
Visual Studio 2015 Update 3, see below (no other version is supported).
Windows 7 or newer.
Install Visual Studio 2015 Update 3 or later - Community Edition should work if its license is appropriate for you. Use the Custom Install option and select:

Visual C++, which will select three sub-categories including MFC
Universal Windows Apps Development Tools > Tools (1.4.1) and Windows 10 SDK (10.0.14393)
Install depot_tools
Linux and Mac
Clone the depot_tools repository from Chromium:

$ git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git
Add depot_tools to the end of your PATH (you will probably want to put this in your ~/.bashrc or ~/.zshrc). Assuming you cloned depot_tools to /path/to/depot_tools:

$ export PATH="$PATH:/path/to/depot_tools"
Windows
Download the depot_tools bundle and extract it somewhere.

*** note Warning: DO NOT use drag-n-drop or copy-n-paste extract from Explorer, this will not extract the hidden “.git” folder which is necessary for depot_tools to autoupdate itself. You can use “Extract all…” from the context menu though.

Add depot_tools to the start of your PATH (must be ahead of any installs of Python). Assuming you unzipped the bundle to C:\src\depot_tools, open:

Control Panel → System and Security → System → Advanced system settings

If you have Administrator access, Modify the PATH system variable and put C:\src\depot_tools at the front (or at least in front of any directory that might already have a copy of Python or Git).

If you don't have Administrator access, you can add a user-level PATH environment variable and put C:\src\depot_tools at the front, but if your system PATH has a Python in it, you will be out of luck.

Also, add a DEPOT_TOOLS_WIN_TOOLCHAIN system variable in the same way, and set it to 0. This tells depot_tools to use your locally installed version of Visual Studio (by default, depot_tools will try to use a google-internal version).

From a cmd.exe shell, run the command gclient (without arguments). On first run, gclient will install all the Windows-specific bits needed to work with the code, including msysgit and python.

If you run gclient from a non-cmd shell (e.g., cygwin, PowerShell), it may appear to run properly, but msysgit, python, and other tools may not get installed correctly.
If you see strange errors with the file system on the first run of gclient, you may want to disable Windows Indexing.
Get the code
Create a shaka_packager directory for the checkout and change to it (you can call this whatever you like and put it wherever you like, as long as the full path has no spaces):

$ mkdir shaka_packager && cd shaka_packager
Run the gclient tool from depot_tools to check out the code and its dependencies.

$ gclient config https://www.github.com/google/shaka-packager.git --name=src --unmanaged
$ gclient sync
To sync to a particular commit or version, add the '-r <revision>' flag to gclient sync, e.g.

$ gclient sync -r 4cb5326355e1559d60b46167740e04624d0d2f51
$ gclient sync -r v1.2.0
If you don't want the full repo history, you can save some time by adding the --no-history flag to gclient sync.

When the above commands completes, it will have created a hidden .gclient file and a directory called src in the working directory. The remaining instructions assume you have switched to the src directory:

$ cd src
Build Shaka Packager
Linux and Mac
Shaka Packager uses Ninja as its main build tool, which is bundled in depot_tools.

To build the code, run ninja command:

$ ninja -C out/Release
If you want to build debug code, replace Release above with Debug.

We also provide a mechanism to change build settings, for example, you can change build system to make by overriding GYP_GENERATORS:

$ GYP_GENERATORS='make' gclient runhooks
Another example, you can also disable clang by overriding GYP_DEFINES:

$ GYP_DEFINES='clang=0' gclient runhooks
Windows
The instructions are similar, except that Windows allows using either / or \ as path separator:

$ ninja -C out/Release
$ ninja -C out\Release
Also, unlike Linux / Mac, 32-bit is chosen by default even if the system is 64-bit. 64-bit has to be enabled explicitly and the output directory is configured to out/%CONFIGURATION%_x64, i.e.:

$ GYP_DEFINES='target_arch=x64' gclient runhooks
$ ninja -C out/Release_x64
Build artifacts
After a successful build, you can find build artifacts including the main packager binary in build output directory (out/Release or out/Release_x64 for release build).

See Shaka Packager Documentation on how to use Shaka Packager.

Update your checkout
To update an existing checkout, you can run

$ git pull origin master --rebase
$ gclient sync
The first command updates the primary Packager source repository and rebases on top of tip-of-tree (aka the Git branch origin/master). You can also use other common Git commands to update the repo.

The second command syncs dependencies to the appropriate versions and re-runs hooks as needed.

Cross compiling for ARM on Ubuntu host
The install-build-deps script can be used to install all the compiler and library dependencies directly from Ubuntu:

$ ./packager/build/install-build-deps.sh
Install sysroot image and others using gclient:

$ GYP_CROSSCOMPILE=1 GYP_DEFINES="target_arch=arm" gclient runhooks
The build command is the same as in Ubuntu:

$ ninja -C out/Release
Notes for other linux distros
Alpine Linux
Use apk command to install dependencies:

$ apk add --no-cache bash build-base curl findutils git ninja python \
                     bsd-compat-headers linux-headers libexecinfo-dev
Alpine uses musl which does not have mallinfo defined in malloc.h. It is required by one of Shaka Packager's dependency. To workaround the problem, a dummy structure has to be defined in /usr/include/malloc.h, e.g.

$ sed -i \
  '/malloc_usable_size/a \\nstruct mallinfo {\n  int arena;\n  int hblkhd;\n  int uordblks;\n};' \
  /usr/include/malloc.h
We also need to disable clang and some other features to make it work with musl:

export GYP_DEFINES='clang=0 use_experimental_allocator_shim=0 use_allocator=none musl=1'
Arch Linux
Instead of running sudo apt-get install to install build dependencies, run:

$ sudo pacman -S --needed python2 git curl gcc gcc-libs make
$ sudo ln -sf python2 /usr/bin/python
Clang requires libtinfo.so.5 which is not available by default on Arch Linux. You can get libtinfo from ncurses5-compat-libs in AUR:

$ git clone https://aur.archlinux.org/ncurses5-compat-libs.git
$ cd ncurses5-compat-libs
$ gpg --keyserver pgp.mit.edu --recv-keys F7E48EDB
$ makepkg -si
Optionally, disable clang to build with gcc:

$ export GYP_DEFINES='clang=0'
Debian
Same as Ubuntu.

Fedora
Instead of running sudo apt-get install to install build dependencies, run:

$ su -c 'yum install -y git python git curl gcc-c++ findutils bzip2 \
         ncurses-compat-libs'
OpenSUSE
Use zypper command to install dependencies:

sudo zypper in git python python-xml git curl gcc-c++ tar
Tips, tricks, and troubleshooting
Xcode license agreement
If you are getting the error

Agreeing to the Xcode/iOS license requires admin privileges, please re-run as root via sudo.

the Xcode license has not been accepted yet which (contrary to the message) any user can do by running:

$ xcodebuild -license
Only accepting for all users of the machine requires root:

$ sudo xcodebuild -license
Missing curl CA bundle
If you are getting the error

gyp: Call to 'config/mac/find_curl_ca_bundle.sh' returned exit status 1 ...

curl CA bundle is not able to be located. Installing curl with openssl should resolve the issue:

$ brew install curl --with-openssl
Contributing
If you have improvements or fixes, we would love to have your contributions. See https://github.com/google/shaka-packager/blob/master/CONTRIBUTING.md for details.

We have continue integration tests setup on pull requests. You can also verify locally by running the tests manually.

If you know which tests are affected by your change, you can limit which tests are run using the --gtest_filter arg, e.g.:

$ out/Debug/mp4_unittest --gtest_filter="MP4MediaParserTest.*"





------------------------------------------------------------------------------------------------------------------
- REDIS -
------------------------------------------------------------------------------------------------------------------

Redis is an essential part of this application. It queues requests to the server in a line and stores it in its binary cache database.
This is crucial for not overloading the real database and server with requests. Otherwise nodejs hangs after too many requests.

This system must be installed via linux. Follow the instructions below in linux:

wget http://download.redis.io/redis-stable.tar.gz 
OR wget http://download.redis.io/releases/redis-4.0.9.tar.gz

tar xvzf redis-stable.tar.gz
OR $ tar xzf redis-4.0.9.tar.gz

cd redis-stable
OR cd redis-4.0.9 or redis-whatever version #

You may have to do the following in different order. Make sure to do make distclean if errors at end

sudo apt-get install make

sudo apt-get install gcc

sudo apt-get install tcl

sudo apt-get install build-essential

sudo apt-get update

## if there is another error like "fatal error: jemalloc/jemalloc.h: No such file or directory"

## just run "make distclean"

make

make test

################### RUN ###################

Run by going into redis folder. run with redis-server file in src.
Can type src/redis-server when in ~/redis/redis-4.0.9/

Informative website https://hackernoon.com/using-redis-with-node-js-8d87a48c5dd7