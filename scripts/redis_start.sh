docker container rm -f redis
docker run -it --rm \
  --name redis \
  --net host \
  redis:7-alpine