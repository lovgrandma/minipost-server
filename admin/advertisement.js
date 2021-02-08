/** Advertisement Administrator queries file advertisement.js
@version 0.1
@author Jesse Thompson
Contains queries relevant to preparing and managing advertisements for administration, launching live, deleting */

// Will match a user and give them advertiser priviliges to upload advertisements. Can be run after user emails minipost management
const getQueryMakeAdvertiser = () => {
    return "match (a:Person { name: $user }) set a.advertiser = 'unlimited' return a;"
}

// Will match an advertisement and set it to live. This will allow the advertisement to circulate in the ad pool if status is set to "good" or "nudegood" and it is marked as "published"
const getQuerySetVideoAdLive = () => {
    return "match (a:AdVideo { mpd: $mpd }) set a.live = 'true' return a";
}

// Set status to "nudegood". This will match an adVideo or video and set its status to "nudegood" meaning nudity was found but management decided it was appropriate for the platform
const getQuerySetStatusNudeGood = (type = "Video") => {
    if (type == "AdVideo") {
        return "match (a:AdVideo { mpd: $mpd }) set a.status = 'nudegood' return a";
    } else {
        return "match (a:Video { mpd: $mpd }) set a.status = 'nudegood' return a"; 
    }
}