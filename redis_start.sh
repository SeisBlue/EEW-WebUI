docker container rm -f redis
docker run -it --rm \
  --net host \
  redis:7-alpine \
  redis-server --save --appendonly no