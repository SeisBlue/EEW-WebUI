docker container rm -f earthworm
docker run -it --rm \
  --name earthworm \
  -v ${PWD}/params:/opt/Earthworm/run/params \
  -v ${PWD}/logs:/opt/Earthworm/run/logs \
  -v ${PWD}/wavefile:/opt/Earthworm/wavefile \
  -v ${PWD}/pick_eew:/opt/Earthworm/earthworm_8.0/bin/pick_eew \
 --ipc shareable \
 seisblue/earthworm bash -c 'source /opt/Earthworm/run/params/ew_linux.bash && exec startstop'
