require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'WaveformCarplay'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'Waveform'
  s.homepage       = 'https://example.com'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://example.com/waveform-carplay.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # System frameworks for CarPlay templates + remote commands.
  s.frameworks = 'CarPlay', 'MediaPlayer'

  # Only the module sources; Tests/ are excluded (run via xcodebuild on a Mac).
  s.source_files = '*.{h,m,mm,swift}'
end
