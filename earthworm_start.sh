docker container rm -f earthworm
docker run -it --rm \
  --name earthworm \
  -v ${PWD}/params:/opt/earthworm/run/params:ro \
  -v ${PWD}/wavefile:/opt/earthworm/wavefile:ro \
  --ipc host \
  --net host \
  seisblue/earthworm \
  bash -c 'source /opt/earthworm/run/params/ew_linux.bash && startstop'
