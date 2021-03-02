Backend Service for minipost LLC

SHAKA PACKAGER

Please install depot tools in scripts folder first, requires python. Then install shaka packager in scripts folder without shaka packager folder. This is required for creating mpd files. Again, will require manual linux installation in scripts folder. May not work if you create shaka_packager folder. Skip and simply run 

$ gclient config https://www.github.com/google/shaka-packager.git --name=src --unmanaged
$ gclient sync

after installing depot tools. See shaka_packager documentation to install shaka.

REDIS


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

Remember for saving gitignore changes to files already committed

git rm --cached -r .
git add .
git commit
git push